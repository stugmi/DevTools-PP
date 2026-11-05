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
  tsDiagnostics: "se.tsDiagnostics",
};

const EDITOR_DEFAULTS = {
  theme: "vs-dark",
  fontFamily: "Cascadia Code, Consolas, monospace",
  fontSize: 12,
};

const RESOURCE_URL_BLACKLIST = [
  // Temp fix for annoying devtools manifest v3 warning/error.
  "chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj",
];

const prefs = {
  prettyDefault: localStorage.getItem(PREF_KEYS.prettyDefault) === "1",
  prettyOnExport: localStorage.getItem(PREF_KEYS.prettyOnExport) === "1",
  editorTheme: localStorage.getItem(PREF_KEYS.editorTheme) || EDITOR_DEFAULTS.theme,
  editorFontFamily: localStorage.getItem(PREF_KEYS.editorFontFamily) || EDITOR_DEFAULTS.fontFamily,
  editorFontSize:
    Number(localStorage.getItem(PREF_KEYS.editorFontSize)) || EDITOR_DEFAULTS.fontSize,
  editorDisableSmoothScroll: localStorage.getItem(PREF_KEYS.editorDisableSmoothScroll) === "1",
  collectAcrossNavigations: localStorage.getItem(PREF_KEYS.collectAcrossNavigations) === "1",
  workspace: localStorage.getItem(PREF_KEYS.workspace) === "network" ? "network" : "files",
  // Pretty-print request/response bodies in the Network detail view. On unless
  // the user explicitly turned it off.
  formatBodies: localStorage.getItem(PREF_KEYS.formatBodies) !== "0",
  archiveFormat: localStorage.getItem(PREF_KEYS.archiveFormat) === "tar" ? "tar" : "zip",
  // How strictly TypeScript checks authored files: "smart" | "syntax" | "off".
  tsDiagnostics: ["smart", "syntax", "off"].includes(localStorage.getItem(PREF_KEYS.tsDiagnostics))
    ? localStorage.getItem(PREF_KEYS.tsDiagnostics)
    : "smart",
};

try {
  document.documentElement.setAttribute("data-theme", prefs.editorTheme);
} catch {
  // ignore if document not ready
}

function savePref(key, value) {
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

const state = {
  sourceTree: {},
  treeModel: null,
  rawTree: {},
  rawTreeModel: null,
  requestTree: {},
  requestTreeModel: null,
  rawByURL: new Map(),
  requestPathCounts: new Map(),
  capturedRequestKeys: new Set(),
  requestOccurrences: new Map(),
  requestCaptureSequence: 0,
  contentTypesByURL: new Map(),
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
  },
  selectedPath: null,
  selectedSection: null,
  contextTarget: null,
  filterText: "",
  scannedScripts: new Set(),
  scanning: false,
  rawCache: new Map(),
  lastPreviewText: "",
  lastPreviewOriginal: "",
  lastPreviewLang: null,
  lastPreviewBadge: null,
  tabs: [],
  activeTabId: null,
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
  btnSettings: $("btn-settings"),
  btnToggleLeft: $("btn-toggle-left"),
  btnToggleBottom: $("btn-toggle-bottom"),
  btnToggleRight: $("btn-toggle-right"),
  btnSearchCollapse: $("btn-search-collapse"),
  statusFilter: $("status-filter"),
  viewMenu: $("view-menu"),
  previewActions: $("preview-actions"),
  emptyState: $("empty-state"),
  treeRoot: $("tree-root"),
  fileCount: $("file-count"),
  filterInput: $("filter-input"),
  formatSelect: $("format-select"),
  viewToggle: $("view-toggle"),
  main: $("main"),
  workspaceTabs: $("workspace-tabs"),
  networkPanel: $("network-panel"),
  networkCount: $("network-count"),
  networkExport: $("network-export"),
  networkTableHeader: $("network-table-header"),
  networkTableBody: $("network-table-body"),
  requestFilters: $("request-filters"),
  requestFilterClear: $("request-filter-clear"),
  requestDomainFilter: $("request-domain-filter"),
  requestTypeFilters: $("request-type-filters"),
  requestMethodFilter: $("request-method-filter"),
  requestTimeMin: $("request-time-min"),
  requestTimeMax: $("request-time-max"),
  previewPanel: $("preview-panel"),
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
  requestDetailBody: $("request-detail-body"),
  previewFooter: $("preview-footer"),
  previewMeta: $("preview-meta"),
  previewLangBadge: $("preview-lang-badge"),
  previewScriptUrl: $("preview-script-url"),
  previewMapUrl: $("preview-map-url"),
  contextMenu: $("context-menu"),
  ctxExportFile: $("ctx-export-file"),
  ctxExportDir: $("ctx-export-dir"),
  ctxExportAll: $("ctx-export-all"),
  ctxExportSection: $("ctx-export-section"),
  ctxCollapseAll: $("ctx-collapse-all"),
  ctxExpandAll: $("ctx-expand-all"),
  ctxCopyPath: $("ctx-copy-path"),
  progressOverlay: $("progress-overlay"),
  progressBar: $("progress-bar"),
  progressTitle: $("progress-title"),
  progressDetail: $("progress-detail"),
  workspaceSearch: $("workspace-search"),
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
  const { mode, value, regex } = state.locationFilter;
  const filter = value.trim();
  if (mode === "all" || !filter) return true;

  if (mode === "regex") return Boolean(regex && regex.test(entryLocation(entry)));

  const domain = normalizeDomain(filter);
  const host = entryHost(entry);
  if (!domain || !host) return false;
  if (mode === "subdomains") return host === domain || host.endsWith(`.${domain}`);
  return host === domain;
}

function filteredTreeFor(section) {
  const tree = treeFor(section);
  if (state.locationFilter.mode === "all" || !state.locationFilter.value.trim()) return tree;
  return Object.fromEntries(
    Object.entries(tree).filter(([, entry]) => locationFilterMatches(entry))
  );
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

function switchWorkspace(ws) {
  if (state.workspace === ws) return;
  state.workspace = ws;
  prefs.workspace = ws;
  savePref("workspace", ws);
  window.PanelLayout?.applyWorkspace(ws);
  for (const btn of el.workspaceTabs.querySelectorAll(".workspace-tab")) {
    const active = btn.dataset.workspace === ws;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}
