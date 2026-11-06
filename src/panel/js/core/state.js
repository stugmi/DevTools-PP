// Shared panel state: DevTools handles, stored prefs, the `state` object, DOM refs (`el`),
// and helpers for the location filter and workspaces. Other panel scripts use these globals.
// Loaded after the editor scripts and before everything that reads `state` or `el`.
"use strict";

const insp = chrome.devtools.inspectedWindow;
const network = chrome.devtools.network;

const PREF_KEYS = {
  prettyDefault: "se.prettyDefault",
  prettyOnExport: "se.prettyOnExport",
  editorTheme: "se.editorTheme",
  editorFontFamily: "se.editorFontFamily",
  editorFontSize: "se.editorFontSize",
  editorDisableSmoothScroll: "se.editorDisableSmoothScroll",
  collectAcrossNavigations: "se.collectAcrossNavigations",
  workspace: "se.workspace",
  formatBodies: "se.formatBodies",
  archiveFormat: "se.archiveFormat",
  requestCopyFormat: "se.requestCopyFormat",
  requestCodeLineWidth: "se.requestCodeLineWidth",
  tsDiagnostics: "se.tsDiagnostics",
};

// Theme key and default are repeated in core/theme-boot.js (se.editorTheme, vs-dark); keep in sync.
const EDITOR_DEFAULTS = {
  theme: "vs-dark",
  fontFamily: "Cascadia Code, Consolas, monospace",
  fontSize: 12,
};

// Stored string for a pref, or `fallback` when unset or when storage is unavailable.
function readPref(key, fallback = null) {
  try {
    return localStorage.getItem(PREF_KEYS[key]) ?? fallback;
  } catch {
    return fallback;
  }
}

const prefs = {
  prettyDefault: readPref("prettyDefault") === "1",
  prettyOnExport: readPref("prettyOnExport") === "1",
  editorTheme: readPref("editorTheme") || EDITOR_DEFAULTS.theme,
  editorFontFamily: readPref("editorFontFamily") || EDITOR_DEFAULTS.fontFamily,
  editorFontSize: Number(readPref("editorFontSize")) || EDITOR_DEFAULTS.fontSize,
  editorDisableSmoothScroll: readPref("editorDisableSmoothScroll") === "1",
  collectAcrossNavigations: readPref("collectAcrossNavigations") === "1",
  workspace: readPref("workspace") === "network" ? "network" : "files",
  // Pretty-print request/response bodies in the Network detail view. On unless turned off.
  formatBodies: readPref("formatBodies") !== "0",
  archiveFormat: readPref("archiveFormat") === "tar" ? "tar" : "zip",
  requestCopyFormat: RequestCode.FORMATS.some(
    ({ value }) => value === readPref("requestCopyFormat")
  )
    ? readPref("requestCopyFormat")
    : RequestCode.DEFAULT_FORMAT,
  requestCodeLineWidth: RequestCode.normalizeLineWidth(readPref("requestCodeLineWidth")),
  // How strictly TypeScript checks authored files: "smart" | "syntax" | "off".
  tsDiagnostics: ["smart", "syntax", "off"].find((v) => v === readPref("tsDiagnostics")) ?? "smart",
};

function savePref(key, value) {
  if (!Object.hasOwn(PREF_KEYS, key)) return;
  try {
    if (typeof value === "boolean") {
      localStorage.setItem(PREF_KEYS[key], value ? "1" : "0");
    } else {
      localStorage.setItem(PREF_KEYS[key], String(value));
    }
  } catch {
    // ignore storage failures
  }
}

// Everything captured from the inspected page, plus the indexes and caches derived from it.
// The initial state and resetCapture() both start from this, so the field list lives here
// only. Trees are null-prototype objects: their keys are untrusted page paths such as
// `constructor` or `__proto__`.
function createCaptureState() {
  return {
    sourceTree: Object.create(null),
    // captureKey -> sourceTree entry, so rescans find existing mapped files in O(1).
    sourceByCaptureKey: new Map(),
    treeModel: null,
    rawTree: Object.create(null),
    rawTreeModel: null,
    requestTree: Object.create(null),
    requestTreeModel: null,
    rawByURL: new Map(),
    requestPathCounts: new Map(),
    capturedRequestKeys: new Set(),
    // Request list selection (see core/request-selection.js). `paths` keeps selected request
    // paths even while filters hide them; `anchor` is the start of Shift-click ranges.
    requestSelection: { anchor: null, paths: new Set() },
    requestOccurrences: new Map(),
    requestCaptureSequence: 0,
    contentTypesByURL: new Map(),
    // Scripts with a final scan outcome on the current page (cleared on navigation).
    scannedScripts: new Set(),
    // Failed scan attempts per script URL; a script is given up after MAX_SCAN_ATTEMPTS.
    scanAttempts: new Map(),
    // Script URL -> content signature of its last scan. Survives navigations (collect mode),
    // so unchanged scripts are not mapped again.
    scriptSignatures: new Map(),
    rawCache: new Map(),
  };
}

const state = {
  ...createCaptureState(),
  // Set by the PANEL_SHOWN / PANEL_HIDDEN messages from the DevTools page (capture.js).
  panelVisible: false,
  scanning: false,
  // Bumped on reset and navigation. In-flight scans stop writing once it changes, and raw
  // entries from an older generation get their content refreshed.
  scanGeneration: 0,
  // performance.timeOrigin of the inspected page at the last scan (detects reloads while hidden).
  scanPageId: null,
  collectAcrossNavigations: prefs.collectAcrossNavigations,
  showMapped: true,
  showRaw: true,
  workspace: prefs.workspace,
  requestFilters: {
    domain: "",
    type: "",
    method: "",
    minDuration: "",
    maxDuration: "",
  },
  requestSort: { key: null, dir: "asc" },
  requestDetailTab: "headers",
  // Per-section "Raw" checkboxes on the Headers tab (DevTools style).
  requestRawSections: { response: false, request: false },
  requestDetailFormat: prefs.formatBodies,
  // Format used by the Cookies tab Copy / Save buttons.
  cookieFormat: "json",
  locationFilter: {
    mode: "all",
    value: "",
    regex: null,
    error: "",
    // normalizeDomain(value), computed once in setLocationFilter.
    domain: "",
  },
  selectedPath: null,
  selectedSection: null,
  // Per-list focus, independent of the preview document above.
  // network = focused request path (selected paths live in requestSelection);
  // files = { path, section }.
  listSelection: { network: null, files: null },
  contextTarget: null,
  filterText: "",
  lastPreviewText: "",
  lastPreviewOriginal: "",
  lastPreviewLang: null,
  lastPreviewBadge: null,
  tabs: [],
  activeTabId: null,
  // The active tab each workspace was showing when the other one took over; switchWorkspace
  // parks and restores it so leaving a workspace never loses its detail view.
  parkedActiveTabs: { network: null, files: null },
  prettyView: prefs.prettyDefault,
  workspaceSearchCaseSensitive: false,
  workspaceSearchRegex: false,
  quickPickerMode: null,
  quickPickerAllItems: [],
  quickPickerItems: [],
  quickPickerIndex: -1,
};

const $ = (id) => document.getElementById(id);

const el = {
  statusIndicator: $("status-indicator"),
  statusText: $("status-text"),
  btnRefresh: $("btn-refresh"),
  btnCollectionMode: $("btn-collection-mode"),
  collectionModeLabel: $("collection-mode-label"),
  btnExportAll: $("btn-export-all"),
  btnExportFile: $("btn-export-file"),
  btnCopy: $("btn-copy"),
  btnWrap: $("btn-wrap"),
  btnPretty: $("btn-pretty"),
  btnFindFile: $("btn-find-file"),
  btnReferences: $("btn-references"),
  btnToggleLeft: $("btn-toggle-left"),
  btnToggleBottom: $("btn-toggle-bottom"),
  btnToggleRight: $("btn-toggle-right"),
  btnSearchCollapse: $("btn-search-collapse"),
  statusFilter: $("status-filter"),
  viewMenu: $("view-menu"),
  previewActions: $("preview-actions"),
  emptyState: $("empty-state"),
  treeRoot: $("tree-root"),
  filterInput: $("filter-input"),
  formatSelect: $("format-select"),
  viewToggle: $("view-toggle"),
  main: $("main"),
  workspaceTabs: $("workspace-tabs"),
  networkCount: $("network-count"),
  networkExport: $("network-export"),
  networkTableHeader: $("network-table-header"),
  networkTableBody: $("network-table-body"),
  requestFilterClear: $("request-filter-clear"),
  requestDomainFilter: $("request-domain-filter"),
  requestTypeFilters: $("request-type-filters"),
  requestMethodFilter: $("request-method-filter"),
  requestTimeMin: $("request-time-min"),
  requestTimeMax: $("request-time-max"),
  previewMapBlock: $("preview-map-block"),
  previewTabs: $("preview-tabs"),
  previewPlaceholder: $("preview-placeholder"),
  editorContainer: $("editor-container"),
  previewImageWrap: $("preview-image-wrap"),
  previewImage: $("preview-image"),
  previewImageMeta: $("preview-image-meta"),
  requestDetail: $("request-detail"),
  requestSummary: $("request-summary"),
  requestDetailTabs: $("request-detail-tabs"),
  btnRequestFormat: $("btn-request-format"),
  btnRequestWrap: $("btn-request-wrap"),
  selRequestLang: $("select-request-lang"),
  previewFooter: $("preview-footer"),
  previewMeta: $("preview-meta"),
  previewLangBadge: $("preview-lang-badge"),
  previewScriptUrl: $("preview-script-url"),
  previewMapUrl: $("preview-map-url"),
  contextMenu: $("context-menu"),
  progressOverlay: $("progress-overlay"),
  progressBar: $("progress-bar"),
  progressTitle: $("progress-title"),
  progressDetail: $("progress-detail"),
  workspaceSearchForm: $("workspace-search-form"),
  workspaceSearchInput: $("workspace-search-input"),
  workspaceSearchSummary: $("workspace-search-summary"),
  workspaceSearchResults: $("workspace-search-results"),
  btnSearchCase: $("btn-search-case"),
  btnSearchRegex: $("btn-search-regex"),
  quickPicker: $("quick-picker"),
  quickPickerTitle: $("quick-picker-title"),
  quickPickerHint: $("quick-picker-hint"),
  quickPickerInput: $("quick-picker-input"),
  quickPickerResults: $("quick-picker-results"),
};

function setStatus(kind, text) {
  el.statusIndicator.className = `indicator ${kind}`;
  el.statusText.textContent = text;
}

function treeFor(section) {
  if (section === "raw") return state.rawTree;
  if (section === "requests") return state.requestTree;
  return state.sourceTree;
}

function modelFor(section) {
  if (section === "raw") return state.rawTreeModel;
  if (section === "requests") return state.requestTreeModel;
  return state.treeModel;
}

function entryLocation(entry) {
  return [entry?.scriptURL, entry?.sourceURL].filter(Boolean).join("\n");
}

function entryHost(entry) {
  for (const value of [entry?.scriptURL, entry?.sourceURL]) {
    if (!value) continue;
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      if (hostname) return hostname.replace(/\.$/, "");
    } catch {
      // Try the next URL field.
    }
  }
  return "";
}

const NO_DOMAIN = "(no domain)";

// The site a captured file belongs to: where its script was served from.
function domainOf(entry) {
  return entryHost(entry) || NO_DOMAIN;
}

function normalizeDomain(value) {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return "";
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  } catch {
    return candidate
      .replace(/^[a-z][a-z\d+.-]*:\/\//, "")
      .split("/")[0]
      .replace(/^\.+|\.+$/g, "");
  }
}

function locationFilterMatches(entry) {
  const { mode, value, regex, domain } = state.locationFilter;
  if (mode === "all" || !value.trim()) return true;

  if (mode === "regex") return Boolean(regex && regex.test(entryLocation(entry)));

  const host = entryHost(entry);
  if (!domain || !host) return false;
  if (mode === "subdomains") return host === domain || host.endsWith(`.${domain}`);
  return host === domain;
}

function filteredTreeFor(section) {
  const tree = treeFor(section);
  if (state.locationFilter.mode === "all" || !state.locationFilter.value.trim()) return tree;
  const out = Object.create(null);
  for (const path in tree) {
    if (locationFilterMatches(tree[path])) out[path] = tree[path];
  }
  return out;
}

function locationFilterActive() {
  return state.locationFilter.mode !== "all" && Boolean(state.locationFilter.value.trim());
}

// Human-readable status for the location filter; shown in Settings and (when a
// filter is active) as a chip in the status bar.
function locationFilterStatusText() {
  if (state.locationFilter.error) return state.locationFilter.error;
  return locationFilterActive() ? "Location filter active" : "All locations shown";
}

function updateLocationFilterUI() {
  const active = locationFilterActive() || Boolean(state.locationFilter.error);
  el.statusFilter.hidden = !active;
  el.statusFilter.classList.toggle("error", Boolean(state.locationFilter.error));
  el.statusFilter.textContent = state.locationFilter.error
    ? "Location filter: invalid regex"
    : `Location filter: ${state.locationFilter.value.trim()}`;
}

function setLocationFilter(mode, value) {
  state.locationFilter.mode = mode;
  state.locationFilter.value = value;
  state.locationFilter.domain = normalizeDomain(value);
  state.locationFilter.regex = null;
  state.locationFilter.error = "";
  if (mode === "regex" && value.trim()) {
    try {
      state.locationFilter.regex = new RegExp(value, "i");
    } catch (error) {
      state.locationFilter.error = `Invalid regex: ${error.message}`;
    }
  }
  updateLocationFilterUI();
  rebuild();
}

const ALL_SECTIONS = ["mapped", "raw", "requests"];

function enabledSections() {
  const out = [];
  if (state.showMapped) out.push("mapped");
  if (state.showRaw) out.push("raw");
  return out;
}

function tabId(path, section) {
  return section + "::" + path;
}

function workspaceForSection(section) {
  return section === "requests" ? "network" : "files";
}

function tabsForWorkspace(ws) {
  return state.tabs.filter((t) => workspaceForSection(t.section) === ws);
}

// Remembers the active tab under the workspace it belongs to (normally the visible one, but a
// capture migration can leave it pointing at the other). The visible workspace is cleared first
// so a dismissed detail view is not resurrected.
function parkActiveTab() {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  state.parkedActiveTabs[state.workspace] = null;
  if (active) state.parkedActiveTabs[workspaceForSection(active.section)] = active.id;
}

function switchWorkspace(ws) {
  if (state.workspace === ws) return;
  parkActiveTab();
  state.workspace = ws;
  prefs.workspace = ws;
  savePref("workspace", ws);
  const parked = state.parkedActiveTabs[ws];
  state.activeTabId = tabsForWorkspace(ws).some((tab) => tab.id === parked) ? parked : null;
  window.PanelLayout?.applyWorkspace(ws);
  // The network table is only rendered while its workspace is visible: catch up now.
  refreshNetwork();
  for (const btn of el.workspaceTabs.querySelectorAll(".workspace-tab")) {
    const active = btn.dataset.workspace === ws;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}
