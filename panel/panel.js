"use strict";

const insp = chrome.devtools.inspectedWindow;
const network = chrome.devtools.network;

const PREF_KEYS = {
  prettyDefault: "se.prettyDefault",
  prettyOnExport: "se.prettyOnExport",
};

const prefs = {
  prettyDefault: localStorage.getItem(PREF_KEYS.prettyDefault) === "1",
  prettyOnExport: localStorage.getItem(PREF_KEYS.prettyOnExport) === "1",
};

function savePref(key, value) {
  try {
    localStorage.setItem(PREF_KEYS[key], value ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

const state = {
  sourceTree: {},
  treeModel: null,
  rawTree: {},
  rawTreeModel: null,
  rawByURL: new Map(),
  contentTypesByURL: new Map(),
  showMapped: true,
  showRaw: false,
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
};

const $ = (id) => document.getElementById(id);

const el = {
  statusIndicator: $("status-indicator"),
  statusText: $("status-text"),
  btnRefresh: $("btn-refresh"),
  btnExportAll: $("btn-export-all"),
  btnExportFile: $("btn-export-file"),
  btnCopy: $("btn-copy"),
  btnWrap: $("btn-wrap"),
  btnPretty: $("btn-pretty"),
  btnSettings: $("btn-settings"),
  settingsPopover: $("settings-popover"),
  optPrettyDefault: $("opt-pretty-default"),
  optPrettyExport: $("opt-pretty-export"),
  previewActions: $("preview-actions"),
  emptyState: $("empty-state"),
  treeRoot: $("tree-root"),
  fileCount: $("file-count"),
  filterInput: $("filter-input"),
  formatSelect: $("format-select"),
  viewToggle: $("view-toggle"),
  previewMapBlock: $("preview-map-block"),
  previewTabs: $("preview-tabs"),
  previewPlaceholder: $("preview-placeholder"),
  previewPre: $("preview-pre"),
  previewGutter: $("preview-gutter"),
  previewCode: $("preview-code"),
  previewCodeContent: $("preview-code-content"),
  previewImageWrap: $("preview-image-wrap"),
  previewImage: $("preview-image"),
  previewImageMeta: $("preview-image-meta"),
  previewFooter: $("preview-footer"),
  previewMeta: $("preview-meta"),
  previewLangBadge: $("preview-lang-badge"),
  previewScriptUrl: $("preview-script-url"),
  previewMapUrl: $("preview-map-url"),
  contextMenu: $("context-menu"),
  ctxExportFile: $("ctx-export-file"),
  ctxExportDir: $("ctx-export-dir"),
  ctxExportAll: $("ctx-export-all"),
  progressOverlay: $("progress-overlay"),
  progressBar: $("progress-bar"),
  progressTitle: $("progress-title"),
  progressDetail: $("progress-detail"),
};

function setStatus(kind, text) {
  el.statusIndicator.className = `indicator ${kind}`;
  el.statusText.textContent = text;
}

function treeFor(section) {
  return section === "raw" ? state.rawTree : state.sourceTree;
}

function modelFor(section) {
  return section === "raw" ? state.rawTreeModel : state.treeModel;
}

function enabledSections() {
  const out = [];
  if (state.showMapped) out.push("mapped");
  if (state.showRaw) out.push("raw");
  return out;
}

function tabId(path, section) {
  return section + "::" + path;
}

// ── Resource discovery via DevTools API (no debugger attach) ────────────────

function getResources() {
  return new Promise((resolve) => insp.getResources(resolve));
}

function getHAR() {
  return new Promise((resolve) => network.getHAR(resolve));
}

function getResourceContent(resource) {
  return new Promise((resolve) => {
    resource.getContent((content, encoding) => resolve({ content, encoding }));
  });
}

function decodeResource({ content, encoding }) {
  if (content == null) return null;
  if (encoding === "base64") {
    try {
      return atob(content);
    } catch {
      return null;
    }
  }
  return content;
}

const SOURCEMAP_RE = /[/][/*][#@]\s*sourceMappingURL=([^\s'"*]+)/;

function extractSourceMapURL(scriptContent) {
  const tail = scriptContent.length > 8192 ? scriptContent.slice(-8192) : scriptContent;
  const m = tail.match(SOURCEMAP_RE);
  return m ? m[1].trim() : null;
}

function resolveURL(base, rel) {
  if (rel.startsWith("data:")) return rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function decodeDataMap(url) {
  const b64 = url.match(/^data:application\/json(?:;[^,]*)?;base64,(.*)$/);
  if (b64) {
    try {
      return JSON.parse(atob(b64[1]));
    } catch {
      return null;
    }
  }
  const utf = url.match(/^data:application\/json(?:;[^,]*)?,(.*)$/);
  if (utf) {
    try {
      return JSON.parse(decodeURIComponent(utf[1]));
    } catch {
      return null;
    }
  }
  return null;
}

async function loadMap(mapURL, resourceMap) {
  if (mapURL.startsWith("data:")) return decodeDataMap(mapURL);

  const res = resourceMap.get(mapURL);
  if (res) {
    const decoded = decodeResource(await getResourceContent(res));
    if (decoded) {
      try {
        return JSON.parse(decoded);
      } catch {
        // fall through to network
      }
    }
  }

  try {
    const r = await fetch(mapURL);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function normalizePath(raw) {
  const p = raw
    .replace(/^webpack(-internal)?:\/\/+/, "")
    .replace(/^[a-z]+:\/\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "");
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const cleaned = parts.join("/");
  return cleaned || null;
}

// vue-loader emits virtual chunks per SFC. Display paths collide because the URL
// query (?vue&type=X or webpack hash like ?5e8e) is stripped during normalization.
// We classify chunks by query first, then by content sniffing (covers builds that
// use opaque hash queries), and suffix non-canonical chunks: foo.template.vue,
// foo.script.vue, foo.style.vue, foo.proxy.vue. Canonical SFC keeps foo.vue.
function vueChunkSuffix(raw, content) {
  const q = raw.match(/[?&]vue&type=([a-zA-Z][\w-]*)/);
  if (q) return q[1].toLowerCase();
  if (typeof content !== "string") return null;
  const head = content.slice(0, 4096);
  if (/^\s*<template[\s>]/.test(head) || /<\/template>\s*<script/.test(head)) return null;
  if (/\bvar\s+render\s*=\s*function/.test(head) && /staticRenderFns/.test(head)) return "template";
  if (/import\s+.+\?vue&type=template/.test(head) && /\?vue&type=script/.test(head)) return "proxy";
  if (/stylePostLoader/.test(head)) return "style";
  if (/^\s*export\s+\*\s+from\s+["'][^"']*\?vue&type=style/.test(head)) return "style";
  if (/\?vue&type=script/.test(head)) return "script";
  return null;
}

function insertSuffixBeforeExt(path, suffix) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return path + "." + suffix;
  return path.slice(0, dot) + "." + suffix + path.slice(dot);
}

function disambiguatePath(basePath, raw, content, tree) {
  const vueType = vueChunkSuffix(raw, content);
  const candidate = vueType ? insertSuffixBeforeExt(basePath, vueType) : basePath;
  if (!tree[candidate]) return candidate;
  let i = 2;
  let next;
  do {
    next = insertSuffixBeforeExt(candidate, String(i));
    i++;
  } while (tree[next]);
  return next;
}

function addMapToTree(map, scriptURL, mapURL) {
  if (!map || !Array.isArray(map.sources)) return 0;
  let added = 0;
  for (let i = 0; i < map.sources.length; i++) {
    const raw = map.sources[i];
    if (!raw) continue;
    const cleanPath = normalizePath(raw);
    if (!cleanPath) continue;
    const content =
      map.sourcesContent && map.sourcesContent[i] != null ? map.sourcesContent[i] : null;
    const path = disambiguatePath(cleanPath, raw, content, state.sourceTree);
    state.sourceTree[path] = {
      content,
      sourceURL: raw,
      scriptURL,
      mapURL,
      fetchStatus: content != null ? "ok" : "missing",
    };
    added++;
  }
  return added;
}

const TYPE_DEFAULT_EXT = {
  document: "html",
  stylesheet: "css",
  script: "js",
  image: "png",
  font: "woff",
  manifest: "json",
};

function rawResourcePath(url, type) {
  if (!url) return null;
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  if (url.startsWith("chrome-extension://") || url.startsWith("devtools://")) return null;
  try {
    const u = new URL(url);
    const host = u.hostname || "(no-host)";
    let path = u.pathname.replace(/^\/+/, "");
    if (!path || path.endsWith("/")) {
      const ext = TYPE_DEFAULT_EXT[type] || "";
      path += ext ? "index." + ext : "index";
    } else {
      // Filename has no extension — synthesize one from resource type.
      const last = path.split("/").pop();
      if (last && !last.includes(".")) {
        const ext = TYPE_DEFAULT_EXT[type];
        if (ext) path += "." + ext;
      }
    }
    return host + "/" + path;
  } catch {
    return null;
  }
}

function contentTypeFromHAR(entry) {
  const response = entry && entry.response;
  if (!response) return null;
  const header = (response.headers || []).find((h) => h.name.toLowerCase() === "content-type");
  return (header && header.value) || response.content?.mimeType || null;
}

function updateContentTypesFromHAR(har) {
  if (!har || !har.entries) return;
  for (const entry of har.entries) {
    const url = entry.request && entry.request.url;
    const contentType = contentTypeFromHAR(entry);
    if (url && contentType) state.contentTypesByURL.set(url, contentType);
  }
}

function addRawResource(r) {
  if (!r || !r.url) return false;
  if (state.rawByURL.has(r.url)) return false;
  const base = rawResourcePath(r.url, r.type);
  if (!base) return false;
  let path = base;
  let i = 1;
  while (state.rawTree[path]) {
    i++;
    path = base + "." + i;
  }
  state.rawTree[path] = {
    content: null,
    sourceURL: r.url,
    scriptURL: r.url,
    mapURL: null,
    type: r.type,
    contentType: state.contentTypesByURL.get(r.url) || null,
    _resource: r,
  };
  state.rawByURL.set(r.url, path);
  return true;
}

function rebuildRawTree(resources) {
  state.rawTree = {};
  state.rawByURL = new Map();
  for (const r of resources) addRawResource(r);
}

async function processScript(resource, resourceMap) {
  if (!resource || !resource.url) return 0;
  if (state.scannedScripts.has(resource.url)) return 0;
  state.scannedScripts.add(resource.url);

  const content = decodeResource(await getResourceContent(resource));
  if (!content) return 0;

  const smURL = extractSourceMapURL(content);
  if (!smURL) return 0;

  const resolved = resolveURL(resource.url, smURL);
  const map = await loadMap(resolved, resourceMap);
  if (!map) return 0;

  return addMapToTree(map, resource.url, resolved);
}

async function scanAll() {
  if (state.scanning) return;
  state.scanning = true;
  setStatus("connecting", "Scanning sources…");
  try {
    updateContentTypesFromHAR(await getHAR());
    const resources = await getResources();
    const resourceMap = new Map(resources.map((r) => [r.url, r]));
    const scripts = resources.filter((r) => r.type === "script");

    rebuildRawTree(resources);

    for (const s of scripts) {
      await processScript(s, resourceMap);
    }
    rebuild();
  } finally {
    state.scanning = false;
  }
}

function rebuild() {
  state.treeModel = buildTreeModel(state.sourceTree);
  state.rawTreeModel = buildTreeModel(state.rawTree);

  const mappedCount = Object.keys(state.sourceTree).length;
  const rawCount = Object.keys(state.rawTree).length;
  const visibleCount = (state.showMapped ? mappedCount : 0) + (state.showRaw ? rawCount : 0);

  el.fileCount.textContent = visibleCount || "—";

  if (visibleCount === 0) {
    const msg =
      state.showMapped && !state.showRaw
        ? "Watching — no source maps detected yet"
        : !state.showMapped && state.showRaw
          ? "Watching — no resources captured yet"
          : "Watching — nothing to show";
    setStatus("active", msg);
    el.btnExportAll.disabled = true;
    el.emptyState.style.display = "flex";
    el.treeRoot.style.display = "none";
    return;
  }

  const parts = [];
  if (state.showMapped) parts.push(`${mappedCount} mapped`);
  if (state.showRaw) parts.push(`${rawCount} raw`);
  setStatus("active", `Watching — ${parts.join(", ")}`);
  el.btnExportAll.disabled = false;
  renderTree();
}

// Live updates
insp.onResourceAdded.addListener((resource) => {
  if (!resource) return;
  setTimeout(async () => {
    const addedRaw = addRawResource(resource);
    let addedMapped = 0;
    if (resource.type === "script") {
      const resources = await getResources();
      const resourceMap = new Map(resources.map((r) => [r.url, r]));
      addedMapped = await processScript(resource, resourceMap);
    }
    if (addedRaw || addedMapped > 0) rebuild();
  }, 250);
});

network.onNavigated.addListener(() => {
  state.sourceTree = {};
  state.rawTree = {};
  state.rawByURL = new Map();
  state.contentTypesByURL = new Map();
  state.scannedScripts.clear();
  state.rawCache = new Map();
  state.treeModel = null;
  state.rawTreeModel = null;
  state.selectedPath = null;
  state.selectedSection = null;
  state.tabs = [];
  state.activeTabId = null;
  el.fileCount.textContent = "—";
  el.btnExportAll.disabled = true;
  el.emptyState.style.display = "flex";
  el.treeRoot.style.display = "none";
  resetPreview();
  renderTabs();
  setTimeout(scanAll, 400);
});

network.onRequestFinished.addListener((request) => {
  const url = request.request && request.request.url;
  const contentType = contentTypeFromHAR(request);
  if (!url || !contentType) return;
  state.contentTypesByURL.set(url, contentType);
  const path = state.rawByURL.get(url);
  if (path && state.rawTree[path]) {
    state.rawTree[path].contentType = contentType;
  }
});

// ── Tree model ───────────────────────────────────────────────────────────────

function buildTreeModel(flat) {
  const root = { name: "", children: {}, files: {}, path: "" };

  for (const [filePath, data] of Object.entries(flat)) {
    const parts = filePath.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: {}, path: currentPath };
      }
      node = node.children[part];
    }

    const filename = parts[parts.length - 1];
    node.files[filename] = { name: filename, path: filePath, data };
  }

  return root;
}

// ── Render tree ──────────────────────────────────────────────────────────────

const openDirs = new Set();

function renderTree() {
  el.emptyState.style.display = "none";
  el.treeRoot.style.display = "block";
  el.treeRoot.innerHTML = "";

  const filter = state.filterText.toLowerCase();
  const sections = enabledSections();
  const showHeaders = sections.length > 1;

  for (const section of sections) {
    const model = modelFor(section);
    if (!model) continue;
    const tree = treeFor(section);
    const count = Object.keys(tree).length;
    if (showHeaders) {
      renderSectionHeader(section, count);
    }
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-section-empty";
      empty.textContent =
        section === "mapped" ? "No source maps detected" : "No resources captured";
      el.treeRoot.appendChild(empty);
      continue;
    }
    renderNode(model, el.treeRoot, 0, filter, section);
  }
}

function renderSectionHeader(section, count) {
  const header = document.createElement("div");
  header.className = "tree-section-header";
  header.dataset.section = section;
  const label = section === "mapped" ? "Authored (source-mapped)" : "Deployed (raw)";
  header.innerHTML = `
    <span class="tree-section-label">${label}</span>
    <span class="tree-section-count">${count}</span>
  `;
  el.treeRoot.appendChild(header);
}

function renderNode(node, container, depth, filter, section) {
  const dirs = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
  const files = Object.values(node.files).sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    if (filter && !dirHasMatch(dir, filter)) continue;
    renderDirNode(dir, container, depth, filter, section);
  }

  for (const file of files) {
    if (filter && !file.path.toLowerCase().includes(filter)) continue;
    renderFileNode(file, container, depth, filter, section);
  }
}

function dirHasMatch(dir, filter) {
  if (dir.name.toLowerCase().includes(filter)) return true;
  for (const f of Object.values(dir.files)) {
    if (f.path.toLowerCase().includes(filter)) return true;
  }
  for (const child of Object.values(dir.children)) {
    if (dirHasMatch(child, filter)) return true;
  }
  return false;
}

function dirKey(section, dirPath) {
  return section + "::" + dirPath;
}

function renderDirNode(dir, container, depth, filter, section) {
  const key = dirKey(section, dir.path);
  const isOpen = openDirs.has(key) || (filter && filter.length > 0);
  const childCount = countDescendants(dir);

  const row = document.createElement("div");
  row.className = "tree-node";
  row.style.paddingLeft = `${4 + depth * 14}px`;
  row.dataset.path = dir.path;
  row.dataset.type = "dir";
  row.dataset.section = section;

  row.innerHTML = `
    <span class="node-toggle ${isOpen ? "open" : ""}">    
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="node-icon">
      <svg width="18px" height="18px" viewBox="0 0 32 32" fill="none">
        <g id="open-folder" stroke="none" stroke-width="0.5" fill="none" fill-rule="evenodd">
            <path d="M25.0000062,26 L4,26 L8.86270857,13.0901619 L29.8196782,13.0901619 L25.0000062,26 Z M7.22746157,11.454917 L4,26 L4,5 L11.2725415,5 L14.500001,8.22745952 L25.0000062,8.22745952 L25.0000062,11.454917 L7.22746157,11.454917 Z" id="path92" fill="#3d5a7a" stroke="#5a80a0" fill-rule="nonzero"></path>
        </g>
    </svg>
    </span>
    <span class="node-name dir-name">${highlightMatch(dir.name, filter)}</span>
    <span class="node-badge">${childCount}</span>
  `;

  const childContainer = document.createElement("div");
  childContainer.className = "tree-children";
  childContainer.style.display = isOpen ? "block" : "none";

  let childrenRendered = isOpen;

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = childContainer.style.display === "none";
    childContainer.style.display = nowOpen ? "block" : "none";
    row.querySelector(".node-toggle").classList.toggle("open", nowOpen);
    if (nowOpen) {
      openDirs.add(key);
      if (!childrenRendered) {
        renderNode(dir, childContainer, depth + 1, filter, section);
        childrenRendered = true;
      }
    } else {
      openDirs.delete(key);
    }
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.contextTarget = { type: "dir", path: dir.path, section };
    showContextMenu(e.clientX, e.clientY, "dir");
  });

  container.appendChild(row);
  container.appendChild(childContainer);

  if (isOpen) {
    renderNode(dir, childContainer, depth + 1, filter, section);
  }
}

function renderFileNode(file, container, depth, filter, section) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const isMissing = file.data && file.data.fetchStatus === "missing";
  const isSelected = state.selectedSection === section && state.selectedPath === file.path;
  let cls = "tree-node";
  if (isSelected) cls += " selected";
  if (isMissing) cls += " missing";
  const row = document.createElement("div");
  row.className = cls;
  row.style.paddingLeft = `${4 + depth * 14 + 14}px`;
  row.dataset.path = file.path;
  row.dataset.type = "file";
  row.dataset.section = section;
  if (isMissing) row.title = "Content unavailable — will be exported as placeholder";

  row.innerHTML = `
    <span class="node-icon">${fileIcon(ext)}</span>
    <span class="node-name">${highlightMatch(file.name, filter)}</span>
  `;

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    openFile(file.path, section);
  });

  row.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openFile(file.path, section);
    pinTab(tabId(file.path, section), true);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.contextTarget = { type: "file", path: file.path, section };
    openFile(file.path, section);
    showContextMenu(e.clientX, e.clientY, "file");
  });

  container.appendChild(row);
}

function highlightMatch(text, filter) {
  if (!filter) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(filter.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    `<mark>${escapeHtml(text.slice(idx, idx + filter.length))}</mark>` +
    escapeHtml(text.slice(idx + filter.length))
  );
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function countDescendants(dir) {
  let n = Object.keys(dir.files).length;
  for (const child of Object.values(dir.children)) n += countDescendants(child);
  return n;
}

// ── File icons ───────────────────────────────────────────────────────────────

const EXT_COLORS = {
  ts: "#4a9eff",
  tsx: "#4a9eff",
  js: "#c4a44a",
  jsx: "#4ab4c4",
  css: "#9b59b6",
  scss: "#c76494",
  sass: "#c76494",
  html: "#e4704a",
  json: "#7aaa60",
  md: "#8aa4b4",
  vue: "#42b883",
  py: "#3572a5",
  rs: "#dea584",
  go: "#00add8",
  java: "#b07219",
  rb: "#701516",
  svelte: "#ff3e00",
};

function fileIcon(ext) {
  const color = EXT_COLORS[ext] || "#7a8b9a";
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 2h6l3 3v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="${color}22" stroke="${color}" stroke-width="0.7"/>
    <path d="M8 2v3h3" stroke="${color}" stroke-width="0.7" fill="none"/>
  </svg>`;
}

// ── Language detection ───────────────────────────────────────────────────────

const EXT_TO_PRISM = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  css: "css",
  scss: "scss",
  sass: "scss",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  graphql: "graphql",
  gql: "graphql",
  vue: "HTML",
  svelte: "HTML",
  md: "markdown",
};

const LANG_LABELS = {
  javascript: "JS",
  typescript: "TS",
  jsx: "JSX",
  tsx: "TSX",
  css: "CSS",
  scss: "SCSS",
  markup: "HTML",
  json: "JSON",
  python: "PY",
  rust: "RS",
  go: "GO",
  java: "JAVA",
  kotlin: "KT",
  bash: "SH",
  yaml: "YAML",
  graphql: "GQL",
  markdown: "MD",
};

function detectLang(path) {
  const ext = extensionForPath(path);
  return EXT_TO_PRISM[ext] || null;
}

function langFromContentType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "text/javascript" || mime === "application/javascript") return "javascript";
  if (mime === "text/css") return "css";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "markup";
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) return "markup";
  return null;
}

function detectEntryLang(path, entry) {
  return (
    detectLang(path) ||
    langFromContentType(entry && entry.contentType) ||
    sniffLang(entry && entry.content)
  );
}

function sniffLang(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return null;
    }
  }
  return null;
}

function extensionForPath(path) {
  const basename = (path || "").split("/").pop() || "";
  const dot = basename.lastIndexOf(".");
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1).toLowerCase() : "";
}

function badgeForPath(path, lang) {
  if (lang && LANG_LABELS[lang]) return LANG_LABELS[lang];
  const ext = extensionForPath(path);
  return ext ? ext.toUpperCase() : "TXT";
}

const BEAUTIFY_OPTS = {
  indent_size: 2,
  end_with_newline: true,
  preserve_newlines: true,
  max_preserve_newlines: 2,
};

function getBeautifier() {
  if (typeof window === "undefined") return null;
  if (window.beautifier) return window.beautifier;
  if (window.js_beautify || window.css_beautify || window.html_beautify) {
    return {
      js: window.js_beautify,
      css: window.css_beautify,
      html: window.html_beautify,
    };
  }
  return null;
}

function canPrettyFormat(lang) {
  if (!lang) return false;
  if (lang === "json") return true;
  const b = getBeautifier();
  if (!b) return false;
  return ["javascript", "typescript", "jsx", "tsx", "css", "scss", "markup", "html"].includes(lang);
}

function prettyFormat(content, lang) {
  if (lang === "json") {
    return JSON.stringify(JSON.parse(content), null, 2) + "\n";
  }
  const b = getBeautifier();
  if (!b) throw new Error("beautifier unavailable");
  if (lang === "javascript" || lang === "typescript" || lang === "jsx" || lang === "tsx") {
    return b.js(content, BEAUTIFY_OPTS);
  }
  if (lang === "css" || lang === "scss") {
    return b.css(content, BEAUTIFY_OPTS);
  }
  if (lang === "html") {
    return b.html(content, BEAUTIFY_OPTS);
  }
  throw new Error("no formatter for " + lang);
}

function commentHeader(lang, lines) {
  if (lang === "json") return null; // JSON has no comments
  if (lang === "html") {
    return "<!--\n" + lines.map((l) => "  " + l).join("\n") + "\n-->\n\n";
  }
  if (lang === "python" || lang === "yaml" || lang === "bash") {
    return lines.map((l) => "# " + l).join("\n") + "\n\n";
  }
  // js, ts, css, scss, default
  return "/*\n" + lines.map((l) => " * " + l).join("\n") + "\n */\n\n";
}

function tryPretty(content, lang) {
  if (!canPrettyFormat(lang)) return { ok: false, content, reason: "Unsupported file type" };
  try {
    return { ok: true, content: prettyFormat(content, lang) };
  } catch (e) {
    return { ok: false, content, reason: e && e.message ? e.message : String(e) };
  }
}

function updatePrettyButton(lang) {
  if (!el.btnPretty) return;
  const supported = canPrettyFormat(lang);
  el.btnPretty.disabled = !supported;
  el.btnPretty.classList.toggle("active", state.prettyView && supported);
  el.btnPretty.title = supported
    ? state.prettyView
      ? "Showing pretty-formatted version (click for original)"
      : "Pretty-format this file"
    : "No formatter available for this file type";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng"]);

function isImagePath(path, entry) {
  const ext = path.split(".").pop().toLowerCase();
  if (IMAGE_EXTS.has(ext)) return true;
  if (entry && entry.type === "image") return true;
  return false;
}

const PIN_SVG = `<svg class="tab-pin-icon" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M10.97 1.47a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1 0 1.06l-2.06 2.06 1.06 1.06a.75.75 0 0 1-1.06 1.06l-1.06-1.06-2.5 2.5.81.81a.75.75 0 1 1-1.06 1.06l-2.5-2.5L2.78 13.97a.75.75 0 0 1-1.06-1.06l3.38-3.38-2.5-2.5a.75.75 0 1 1 1.06-1.06l.81.81 2.5-2.5L5.91 3.22a.75.75 0 0 1 1.06-1.06L8.03 3.22 10.09 1.16z"/>
</svg>`;

// ── Tabs ─────────────────────────────────────────────────────────────────────

function openFile(path, section) {
  const id = tabId(path, section);
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    state.activeTabId = id;
    renderTabs();
    selectFile(path, section);
    return;
  }

  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active && !active.pinned) {
    active.id = id;
    active.path = path;
    active.section = section;
    state.activeTabId = id;
  } else {
    state.tabs.push({ id, path, section, pinned: false });
    state.activeTabId = id;
  }
  renderTabs();
  selectFile(path, section);
}

function pinTab(id, forcePinned) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  t.pinned = forcePinned == null ? !t.pinned : forcePinned;
  renderTabs();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    if (state.tabs.length) {
      const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      state.activeTabId = next.id;
      renderTabs();
      selectFile(next.path, next.section);
    } else {
      state.activeTabId = null;
      state.selectedPath = null;
      state.selectedSection = null;
      renderTabs();
      resetPreview();
      // refresh tree to drop selected highlight
      if (state.treeModel || state.rawTreeModel) renderTree();
    }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  el.previewTabs.innerHTML = "";
  if (state.tabs.length === 0) {
    const ph = document.createElement("span");
    ph.className = "preview-tabs-empty";
    ph.textContent = "Select a file to preview";
    el.previewTabs.appendChild(ph);
    return;
  }
  for (const t of state.tabs) {
    const tabEl = document.createElement("div");
    tabEl.className = "preview-tab";
    if (t.id === state.activeTabId) tabEl.classList.add("active");
    if (t.pinned) tabEl.classList.add("pinned");
    else tabEl.classList.add("preview");
    tabEl.dataset.tabId = t.id;
    tabEl.title =
      (t.section === "mapped" ? "[mapped] " : "[raw] ") +
      t.path +
      (t.pinned ? "" : " — preview tab (double-click to pin)");

    const filename = t.path.split("/").pop() || t.path;

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = filename;

    const close = document.createElement("span");
    close.className = "tab-close";
    close.title = "Close (middle-click also closes)";
    close.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;

    if (t.pinned) {
      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.title = "Pinned (double-click to unpin)";
      pin.innerHTML = PIN_SVG;
      tabEl.appendChild(pin);
    }
    tabEl.appendChild(name);
    tabEl.appendChild(close);

    tabEl.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) {
        closeTab(t.id);
        return;
      }
      if (state.activeTabId !== t.id) {
        state.activeTabId = t.id;
        renderTabs();
        selectFile(t.path, t.section);
      }
    });
    tabEl.addEventListener("dblclick", (e) => {
      if (e.target.closest(".tab-close")) return;
      pinTab(t.id);
    });
    tabEl.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(t.id);
      }
    });

    el.previewTabs.appendChild(tabEl);
  }
}

// ── File preview ─────────────────────────────────────────────────────────────

function urlBasename(u) {
  if (!u) return "—";
  if (u.startsWith("data:")) return "inline data: URI";
  try {
    const parsed = new URL(u);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || parsed.hostname || u;
  } catch {
    return u;
  }
}

function renderGutter(lineCount) {
  const lines = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) lines[i] = i + 1;
  el.previewGutter.textContent = lines.join("\n");
}

function setFooterURLs(entry) {
  el.previewScriptUrl.textContent = urlBasename(entry.scriptURL);
  el.previewScriptUrl.title = entry.scriptURL || "";
  if (entry.mapURL) {
    el.previewMapBlock.style.display = "inline-flex";
    el.previewMapUrl.textContent = urlBasename(entry.mapURL);
    el.previewMapUrl.title = entry.mapURL;
  } else {
    el.previewMapBlock.style.display = "none";
    el.previewMapUrl.textContent = "";
    el.previewMapUrl.title = "";
  }
}

function renderContent(content, lang, badgeFallback) {
  let display = content;
  if (state.prettyView && canPrettyFormat(lang)) {
    const r = tryPretty(content, lang);
    if (r.ok) display = r.content;
  }
  state.lastPreviewOriginal = content;
  state.lastPreviewText = display;
  state.lastPreviewLang = lang;
  state.lastPreviewBadge = badgeFallback || null;

  el.previewActions.style.display = "flex";
  el.previewPlaceholder.style.display = "none";
  el.previewImageWrap.style.display = "none";
  el.previewPre.style.display = "grid";

  updatePrettyButton(lang);

  const langClass = lang ? `language-${lang}` : "language-plaintext";
  el.previewCodeContent.className = langClass;
  el.previewCodeContent.textContent = display;

  if (window.Prism) Prism.highlightElement(el.previewCodeContent);

  const lines = display.split("\n").length;
  const bytes = new TextEncoder().encode(display).length;
  renderGutter(lines);
  el.previewLangBadge.textContent =
    (lang && LANG_LABELS[lang]) || badgeFallback || (lang || "TXT").toUpperCase();
  el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(bytes)}`;
  el.previewFooter.style.display = "flex";
}

function resetPreview() {
  state.lastPreviewText = "";
  state.lastPreviewOriginal = "";
  el.previewPre.style.display = "none";
  el.previewImageWrap.style.display = "none";
  el.previewFooter.style.display = "none";
  el.previewActions.style.display = "none";
  el.previewPlaceholder.style.display = "flex";
  el.previewPlaceholder.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <path d="M8 4h10l6 6v18H8V4z" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
      <path d="M18 4v6h6" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
      <path d="M11 14h10M11 17h10M11 20h7" stroke="#2a3a4a" stroke-width="1" stroke-linecap="round"/>
    </svg>
    <span>No file selected</span>
  `;
}

async function selectFile(path, section) {
  state.selectedPath = path;
  state.selectedSection = section;

  document.querySelectorAll(".tree-node.selected").forEach((n) => n.classList.remove("selected"));
  const row = document.querySelector(
    `.tree-node[data-section="${section}"][data-path="${CSS.escape(path)}"][data-type="file"]`
  );
  if (row) row.classList.add("selected");

  const tree = treeFor(section);
  const entry = tree[path];
  if (!entry) return;

  setFooterURLs(entry);

  if (isImagePath(path, entry)) {
    renderImage(entry, path);
    return;
  }

  if (
    entry.content == null &&
    entry.fetchStatus !== "missing" &&
    entry.sourceURL &&
    !entry.sourceURL.startsWith("data:")
  ) {
    renderContent("Loading…", null, "…");
    const fetched = await loadRawByURL(entry.sourceURL);
    if (state.selectedPath !== path || state.selectedSection !== section) return;
    if (fetched != null) {
      entry.content = fetched;
      entry.fetchStatus = "ok";
    } else {
      entry.fetchStatus = "missing";
      renderTree();
    }
  }

  if (entry.content != null) {
    const lang = detectEntryLang(path, entry);
    renderContent(entry.content, lang, badgeForPath(path, lang));
  } else {
    state.lastPreviewText = "";
    state.lastPreviewOriginal = "";
    el.previewActions.style.display = "flex";
    el.previewFooter.style.display = "flex";
    el.previewPre.style.display = "none";
    el.previewPlaceholder.style.display = "flex";
    const failed = entry.fetchStatus === "missing";
    const headline = failed
      ? section === "raw"
        ? "Failed to fetch resource"
        : "Source not embedded and could not be fetched"
      : "No source content embedded in map";
    el.previewPlaceholder.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <path d="M8 4h10l6 6v18H8V4z" stroke="${failed ? "#5a3a3a" : "#2a3a4a"}" stroke-width="1.2" fill="none"/>
        <path d="M18 4v6h6" stroke="${failed ? "#5a3a3a" : "#2a3a4a"}" stroke-width="1.2" fill="none"/>
      </svg>
      <span style="color: ${failed ? "var(--red)" : "var(--text-dim)"}; font-size: 11px;">${escapeHtml(headline)}</span>
      <span style="color: var(--text-dim); font-size: 10px; font-family: var(--font-mono)">${escapeHtml(entry.sourceURL || "")}</span>
      <span style="color: var(--text-dim); font-size: 10px;">Will be exported as a placeholder file.</span>
    `;
    el.previewLangBadge.textContent = "";
    el.previewMeta.textContent = "";
  }
}

function renderImage(entry, path) {
  state.lastPreviewText = "";
  state.lastPreviewOriginal = "";
  el.previewActions.style.display = "flex";
  el.previewPlaceholder.style.display = "none";
  el.previewPre.style.display = "none";
  el.previewImageWrap.style.display = "flex";

  const url = entry.sourceURL || entry.scriptURL || "";
  const usable = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:");

  if (usable) {
    el.previewImage.style.display = "block";
    el.previewImage.src = url;
    el.previewImage.alt = path;
    el.previewImage.onload = () => {
      const w = el.previewImage.naturalWidth;
      const h = el.previewImage.naturalHeight;
      el.previewImageMeta.textContent = `${w} × ${h}`;
    };
    el.previewImage.onerror = () => {
      el.previewImage.style.display = "none";
      el.previewImageMeta.textContent = "Failed to load image";
    };
  } else {
    el.previewImage.style.display = "none";
    el.previewImage.removeAttribute("src");
    el.previewImageMeta.textContent = "Image source unavailable (" + (url || "—") + ")";
  }

  const ext = extensionForPath(path).toUpperCase() || "IMG";
  el.previewLangBadge.textContent = ext;
  el.previewMeta.textContent = path.split("/").pop();
  el.previewFooter.style.display = "flex";
}

async function loadRawByURL(url) {
  if (state.rawCache.has(url)) return state.rawCache.get(url);

  const resources = await getResources();
  const r = resources.find((x) => x.url === url);
  let content = null;
  if (r) {
    content = decodeResource(await getResourceContent(r));
  }
  if (!content) {
    try {
      const resp = await fetch(url);
      if (resp.ok) content = await resp.text();
    } catch {
      content = null;
    }
  }
  if (content != null) state.rawCache.set(url, content);
  return content;
}

async function showRawFile(url, kind) {
  if (!url) return;

  if (url.startsWith("data:")) {
    if (kind === "map") {
      const map = decodeDataMap(url);
      if (map) {
        renderContent(JSON.stringify(map, null, 2), "json", "JSON");
      }
    }
    return;
  }

  renderContent("Loading…", null, "…");
  const content = await loadRawByURL(url);
  if (content == null) {
    renderContent("// Failed to load resource.", null, "ERR");
    return;
  }

  if (kind === "map") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // not JSON, show raw
    }
    renderContent(pretty, "json", "JSON");
  } else {
    const lang =
      langFromContentType(state.contentTypesByURL.get(url)) || sniffLang(content) || "javascript";
    renderContent(content, lang, (lang && LANG_LABELS[lang]) || "JS");
  }
}

el.previewScriptUrl.addEventListener("click", () => {
  const u = el.previewScriptUrl.title;
  if (u) showRawFile(u, "script");
});

el.previewMapUrl.addEventListener("click", () => {
  const u = el.previewMapUrl.title;
  if (u) showRawFile(u, "map");
});

// ── Context menu ─────────────────────────────────────────────────────────────

function showContextMenu(x, y, targetType) {
  el.contextMenu.style.display = "block";
  el.ctxExportFile.style.display = targetType === "file" ? "block" : "none";
  el.ctxExportDir.style.display = targetType === "dir" ? "block" : "none";

  const menuW = 180,
    menuH = 90;
  const safeX = Math.min(x, window.innerWidth - menuW - 4);
  const safeY = Math.min(y, window.innerHeight - menuH - 4);
  el.contextMenu.style.left = safeX + "px";
  el.contextMenu.style.top = safeY + "px";
}

function hideContextMenu() {
  el.contextMenu.style.display = "none";
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});

// ── Export ───────────────────────────────────────────────────────────────────

function showProgress(title) {
  el.progressTitle.textContent = title;
  el.progressBar.style.width = "0%";
  el.progressDetail.textContent = "";
  el.progressOverlay.style.display = "flex";
}

function updateProgress(pct, detail) {
  el.progressBar.style.width = Math.round(pct) + "%";
  if (detail) el.progressDetail.textContent = detail;
}

function hideProgress() {
  el.progressOverlay.style.display = "none";
}

function archivePathFor(item) {
  // When both sections are visible, prefix to avoid collisions and clarify origin.
  if (state.showMapped && state.showRaw) {
    const prefix = item.section === "mapped" ? "mapped" : "raw";
    return prefix + "/" + item.path;
  }
  return item.path;
}

async function exportItems(items, archiveName) {
  const format = el.formatSelect.value;
  showProgress(`Building ${format.toUpperCase()} archive...`);

  const rawItems = items.filter((it) => it.section === "raw");
  if (rawItems.length) await ensureRawContent(rawItems);

  const applyPretty = prefs.prettyOnExport;
  let prettyFailed = 0;
  let prettyApplied = 0;

  const files = items
    .map((it) => {
      const tree = treeFor(it.section);
      const entry = tree[it.path];
      if (!entry) return null;
      const archivePath = archivePathFor(it);
      if (entry.content == null) {
        return { path: archivePath, content: makePlaceholder(it.path, entry), placeholder: true };
      }
      let content = entry.content;
      if (applyPretty) {
        const lang = detectEntryLang(it.path, entry);
        if (canPrettyFormat(lang)) {
          const r = tryPretty(content, lang);
          if (r.ok) {
            content = r.content;
            prettyApplied++;
          } else {
            prettyFailed++;
            const header = commentHeader(lang, [
              "Source Exporter: pretty-format failed for this file.",
              "Reason: " + r.reason,
              "Falling back to original (un-formatted) content.",
            ]);
            if (header) content = header + content;
          }
        }
      }
      return { path: archivePath, content, placeholder: false };
    })
    .filter(Boolean);

  if (files.length === 0) {
    hideProgress();
    alert("No exportable files.");
    return;
  }

  const placeholderCount = files.filter((f) => f.placeholder).length;

  if (format === "zip") {
    await exportZip(files, archiveName);
  } else {
    await exportTar(files, archiveName);
  }

  hideProgress();

  const notes = [];
  if (placeholderCount > 0) {
    notes.push(
      `${placeholderCount} placeholder${placeholderCount !== 1 ? "s" : ""} (content unavailable)`
    );
  }
  if (applyPretty) {
    notes.push(`pretty-formatted ${prettyApplied}`);
    if (prettyFailed > 0) notes.push(`${prettyFailed} fell back to original`);
  }
  if (notes.length) {
    setStatus("active", "Exported — " + notes.join(", "));
  }
}

function makePlaceholder(path, entry) {
  const url = entry.sourceURL || entry.scriptURL || "(unknown)";
  const reason =
    entry.fetchStatus === "missing"
      ? "Failed to fetch original content."
      : "Original content was not available (no embedded source content and no successful fetch).";
  return [
    "// Source Exporter placeholder",
    `// Path: ${path}`,
    `// URL:  ${url}`,
    `// ${reason}`,
    "// This file is a placeholder — the original content could not be retrieved.",
    "",
  ].join("\n");
}

async function exportZip(files, name) {
  const zip = new JSZip();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 90, f.path);
    zip.file(f.path, f.content);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  updateProgress(95, "Compressing...");
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => updateProgress(95 + meta.percent * 0.05, "Compressing...")
  );

  updateProgress(100, "Done");
  triggerDownload(blob, `${name}.zip`);
}

async function exportTar(files, name) {
  const chunks = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 95, f.path);

    const encoded = new TextEncoder().encode(f.content);
    chunks.push(makeTarHeader(f.path, encoded.length));
    chunks.push(paddedBlock(encoded));

    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  chunks.push(new Uint8Array(1024));

  updateProgress(100, "Done");
  const blob = new Blob(chunks, { type: "application/x-tar" });
  triggerDownload(blob, `${name}.tar`);
}

function paddedBlock(data) {
  const remainder = data.length % 512;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (512 - remainder));
  padded.set(data);
  return padded;
}

function splitUstarPath(p) {
  if (p.length <= 100) return { name: p, prefix: "" };
  for (let i = Math.max(0, p.length - 100); i < p.length - 1; i++) {
    if (p[i] === "/") {
      const prefix = p.slice(0, i);
      const name = p.slice(i + 1);
      if (prefix.length <= 155 && name.length <= 100 && name.length > 0) {
        return { name, prefix };
      }
    }
  }
  return { name: p.slice(-100), prefix: "" };
}

function makeTarHeader(filePath, fileSize) {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();

  function write(offset, str, maxLen) {
    const bytes = enc.encode(str.slice(0, maxLen));
    header.set(bytes, offset);
  }

  const { name, prefix } = splitUstarPath(filePath);
  write(0, name, 100);
  write(100, "0000644\0", 8);
  write(108, "0000000\0", 8);
  write(116, "0000000\0", 8);
  write(124, fileSize.toString(8).padStart(11, "0") + "\0", 12);
  write(
    136,
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    12
  );
  header[156] = 0x30;
  write(257, "ustar\0", 6);
  write(263, "00", 2);
  if (prefix) write(345, prefix, 155);

  header.fill(0x20, 148, 156);
  let cksum = 0;
  for (const b of header) cksum += b;
  write(148, cksum.toString(8).padStart(6, "0") + "\0 ", 8);

  return header;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Item selectors ───────────────────────────────────────────────────────────

function getAllItems() {
  const out = [];
  for (const section of enabledSections()) {
    for (const path of Object.keys(treeFor(section))) {
      out.push({ path, section });
    }
  }
  return out;
}

function getItemsUnderDir(section, dirPath) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((p) => p === dirPath || p.startsWith(dirPath + "/"))
    .map((path) => ({ path, section }));
}

function getDomainLabel() {
  try {
    const sections = enabledSections();
    for (const section of sections) {
      const tree = treeFor(section);
      const urls = Object.values(tree)
        .map((e) => e.scriptURL || e.sourceURL)
        .filter(Boolean);
      if (urls.length === 0) continue;
      const u = new URL(urls[0]);
      return u.hostname.replace(/^www\./, "");
    }
    return "sources";
  } catch {
    return "sources";
  }
}

async function ensureRawContent(items) {
  const missing = items.filter((it) => {
    const tree = treeFor(it.section);
    const e = tree[it.path];
    return (
      e &&
      e.content == null &&
      e.fetchStatus !== "missing" &&
      e.sourceURL &&
      !e.sourceURL.startsWith("data:")
    );
  });
  for (let i = 0; i < missing.length; i++) {
    const it = missing[i];
    const tree = treeFor(it.section);
    updateProgress((i / missing.length) * 30, `Fetching ${it.path}`);
    const c = await loadRawByURL(tree[it.path].sourceURL);
    if (c != null) {
      tree[it.path].content = c;
      tree[it.path].fetchStatus = "ok";
    } else {
      tree[it.path].fetchStatus = "missing";
    }
  }
}

// ── Wire UI ──────────────────────────────────────────────────────────────────

el.btnRefresh.addEventListener("click", () => {
  state.scannedScripts.clear();
  state.sourceTree = {};
  state.rawTree = {};
  state.rawByURL = new Map();
  state.rawCache = new Map();
  scanAll();
});

el.viewToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".view-pill");
  if (!btn) return;
  const view = btn.dataset.view;
  if (!view) return;

  const next = { showMapped: state.showMapped, showRaw: state.showRaw };
  if (view === "mapped") next.showMapped = !next.showMapped;
  else if (view === "raw") next.showRaw = !next.showRaw;

  if (!next.showMapped && !next.showRaw) return; // keep ≥1 enabled

  state.showMapped = next.showMapped;
  state.showRaw = next.showRaw;

  for (const b of el.viewToggle.querySelectorAll(".view-pill")) {
    const active =
      (b.dataset.view === "mapped" && state.showMapped) ||
      (b.dataset.view === "raw" && state.showRaw);
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  }

  // close tabs whose section is no longer visible
  state.tabs = state.tabs.filter((t) => {
    if (t.section === "mapped") return state.showMapped;
    if (t.section === "raw") return state.showRaw;
    return false;
  });
  if (!state.tabs.find((t) => t.id === state.activeTabId)) {
    if (state.tabs.length) {
      const next = state.tabs[state.tabs.length - 1];
      state.activeTabId = next.id;
      selectFile(next.path, next.section);
    } else {
      state.activeTabId = null;
      state.selectedPath = null;
      state.selectedSection = null;
      resetPreview();
    }
  }
  renderTabs();
  rebuild();
});

el.btnExportAll.addEventListener("click", () => {
  exportItems(getAllItems(), getDomainLabel());
});

el.btnExportFile.addEventListener("click", () => {
  if (!state.selectedPath || !state.selectedSection) return;
  exportItems(
    [{ path: state.selectedPath, section: state.selectedSection }],
    state.selectedPath.split("/").pop()
  );
});

el.btnCopy.addEventListener("click", async () => {
  const text = state.lastPreviewText;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    el.btnCopy.classList.add("copy-success");
    const orig = el.btnCopy.innerHTML;
    el.btnCopy.innerHTML = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5l2.5 3 5-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied`;
    setTimeout(() => {
      el.btnCopy.classList.remove("copy-success");
      el.btnCopy.innerHTML = orig;
    }, 1500);
  } catch {
    // clipboard unavailable in some DevTools contexts
  }
});

let wrapEnabled = false;
el.btnWrap.addEventListener("click", () => {
  wrapEnabled = !wrapEnabled;
  el.previewPre.classList.toggle("wrap-mode", wrapEnabled);
  el.btnWrap.classList.toggle("active", wrapEnabled);
});

el.btnPretty.addEventListener("click", () => {
  if (el.btnPretty.disabled) return;
  state.prettyView = !state.prettyView;
  renderContent(state.lastPreviewOriginal, state.lastPreviewLang, state.lastPreviewBadge);
});

el.optPrettyDefault.checked = prefs.prettyDefault;
el.optPrettyExport.checked = prefs.prettyOnExport;

el.optPrettyDefault.addEventListener("change", () => {
  prefs.prettyDefault = el.optPrettyDefault.checked;
  savePref("prettyDefault", prefs.prettyDefault);
});

el.optPrettyExport.addEventListener("change", () => {
  prefs.prettyOnExport = el.optPrettyExport.checked;
  savePref("prettyOnExport", prefs.prettyOnExport);
});

el.btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = el.settingsPopover.style.display !== "none";
  el.settingsPopover.style.display = open ? "none" : "flex";
});

el.settingsPopover.addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("click", () => {
  el.settingsPopover.style.display = "none";
});

el.filterInput.addEventListener("input", () => {
  state.filterText = el.filterInput.value.trim();
  if (state.treeModel || state.rawTreeModel) renderTree();
});

el.ctxExportFile.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "file") {
    const { path, section } = state.contextTarget;
    exportItems([{ path, section }], path.split("/").pop());
  }
});

el.ctxExportDir.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "dir") {
    const { path, section } = state.contextTarget;
    const items = getItemsUnderDir(section, path);
    const label = path.split("/").pop() || getDomainLabel();
    exportItems(items, label);
  }
});

el.ctxExportAll.addEventListener("click", () => {
  hideContextMenu();
  exportItems(getAllItems(), getDomainLabel());
});

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

// ── Init ─────────────────────────────────────────────────────────────────────

el.previewCodeContent.contentEditable = "true";
el.previewCodeContent.setAttribute("autocorrect", "off");
el.previewCodeContent.setAttribute("autocapitalize", "off");
for (const evt of ["beforeinput", "paste", "drop", "cut", "dragstart"]) {
  el.previewCodeContent.addEventListener(evt, (e) => e.preventDefault());
}

renderTabs();
scanAll();
