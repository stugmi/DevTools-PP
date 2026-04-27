"use strict";

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  tabId: chrome.devtools.inspectedWindow.tabId,
  connected: false,
  sourceTree: {},       // path -> { content, sourceURL, scriptURL }
  treeModel: null,      // hierarchical model
  selectedPath: null,
  contextTarget: null,  // { type: 'file'|'dir', path: string }
  filterText: "",
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const el = {
  statusIndicator: $("status-indicator"),
  statusText: $("status-text"),
  btnConnect: $("btn-connect"),
  btnRefresh: $("btn-refresh"),
  btnExportAll: $("btn-export-all"),
  btnExportFile: $("btn-export-file"),
  btnCopy: $("btn-copy"),
  btnWrap: $("btn-wrap"),
  previewActions: $("preview-actions"),
  emptyState: $("empty-state"),
  treeRoot: $("tree-root"),
  fileCount: $("file-count"),
  filterInput: $("filter-input"),
  formatSelect: $("format-select"),
  previewFilename: $("preview-filename"),
  previewPlaceholder: $("preview-placeholder"),
  previewCode: $("preview-code"),
  previewCodeContent: $("preview-code-content"),
  previewFooter: $("preview-footer"),
  previewMeta: $("preview-meta"),
  previewLangBadge: $("preview-lang-badge"),
  contextMenu: $("context-menu"),
  ctxExportFile: $("ctx-export-file"),
  ctxExportDir: $("ctx-export-dir"),
  ctxExportAll: $("ctx-export-all"),
  progressOverlay: $("progress-overlay"),
  progressBar: $("progress-bar"),
  progressTitle: $("progress-title"),
  progressDetail: $("progress-detail"),
};

// ── Messaging ────────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ── Status ───────────────────────────────────────────────────────────────────

function setStatus(state_, text) {
  el.statusIndicator.className = `indicator ${state_}`;
  el.statusText.textContent = text;
}

// ── Connect / refresh ────────────────────────────────────────────────────────

async function connect() {
  setStatus("connecting", "Connecting...");
  const res = await send({ type: "ATTACH", tabId: state.tabId });
  if (res && res.ok) {
    state.connected = true;
    setStatus("active", `Connected — navigate the page to capture sources`);
    el.emptyState.querySelector("p.empty-sub").innerHTML =
      "Navigate or reload the page. Sources with source maps will be captured automatically.";
  } else {
    setStatus("error", "Failed to connect: " + (res && res.error || "unknown"));
  }
}

async function refreshTree() {
  if (!state.connected) return;
  setStatus("connecting", "Scanning scripts...");

  const res = await send({ type: "BUILD_TREE", tabId: state.tabId });
  if (!res || !res.tree) {
    setStatus("error", "Failed to build source tree");
    return;
  }

  state.sourceTree = res.tree;
  state.treeModel = buildTreeModel(state.sourceTree);

  const count = Object.keys(state.sourceTree).length;
  if (count === 0) {
    setStatus("active", "Connected — no source maps found yet. Try reloading the page.");
    return;
  }

  setStatus("active", `Connected — ${count} source file${count !== 1 ? "s" : ""} captured`);
  el.fileCount.textContent = count;
  el.btnExportAll.disabled = false;

  renderTree();
}

// ── Tree model ────────────────────────────────────────────────────────────────

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

// ── Render tree ───────────────────────────────────────────────────────────────

const openDirs = new Set();

function renderTree() {
  el.emptyState.style.display = "none";
  el.treeRoot.style.display = "block";
  el.treeRoot.innerHTML = "";

  const filter = state.filterText.toLowerCase();
  renderNode(state.treeModel, el.treeRoot, 0, filter);
}

function renderNode(node, container, depth, filter) {
  // Directories first
  const dirs = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
  const files = Object.values(node.files).sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    // Check if any descendant matches filter
    if (filter && !dirHasMatch(dir, filter)) continue;
    renderDirNode(dir, container, depth, filter);
  }

  for (const file of files) {
    if (filter && !file.path.toLowerCase().includes(filter)) continue;
    renderFileNode(file, container, depth, filter);
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

function renderDirNode(dir, container, depth, filter) {
  const isOpen = openDirs.has(dir.path) || (filter && filter.length > 0);
  const childCount = countDescendants(dir);

  const row = document.createElement("div");
  row.className = "tree-node";
  row.style.paddingLeft = `${4 + depth * 14}px`;
  row.dataset.path = dir.path;
  row.dataset.type = "dir";

  row.innerHTML = `
    <span class="node-toggle ${isOpen ? "open" : ""}">
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="node-icon">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.586a1 1 0 0 1 .707.293l1 1H10.5A1.5 1.5 0 0 1 12 4.5V10a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 1 10V3.5z" fill="#3d5a7a" stroke="#5a80a0" stroke-width="0.5"/>
      </svg>
    </span>
    <span class="node-name dir-name">${highlightMatch(dir.name, filter)}</span>
    <span class="node-badge">${childCount}</span>
  `;

  const childContainer = document.createElement("div");
  childContainer.className = "tree-children";
  childContainer.style.display = isOpen ? "block" : "none";

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = childContainer.style.display === "none";
    childContainer.style.display = nowOpen ? "block" : "none";
    row.querySelector(".node-toggle").classList.toggle("open", nowOpen);
    if (nowOpen) openDirs.add(dir.path);
    else openDirs.delete(dir.path);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.contextTarget = { type: "dir", path: dir.path };
    showContextMenu(e.clientX, e.clientY, "dir");
  });

  container.appendChild(row);
  container.appendChild(childContainer);

  if (isOpen) {
    renderNode(dir, childContainer, depth + 1, filter);
  } else {
    // Lazy render on open
    let rendered = false;
    const origClick = row.onclick;
    row.addEventListener("click", () => {
      if (!rendered && childContainer.style.display === "block") {
        rendered = true;
        renderNode(dir, childContainer, depth + 1, filter);
      }
    });
  }
}

function renderFileNode(file, container, depth, filter) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const row = document.createElement("div");
  row.className = "tree-node" + (state.selectedPath === file.path ? " selected" : "");
  row.style.paddingLeft = `${4 + depth * 14 + 14}px`;
  row.dataset.path = file.path;
  row.dataset.type = "file";

  row.innerHTML = `
    <span class="node-icon">${fileIcon(ext)}</span>
    <span class="node-name">${highlightMatch(file.name, filter)}</span>
  `;

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    selectFile(file.path);
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.contextTarget = { type: "file", path: file.path };
    selectFile(file.path);
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

// ── File icons ────────────────────────────────────────────────────────────────

const EXT_COLORS = {
  ts: "#4a9eff", tsx: "#4a9eff", js: "#c4a44a", jsx: "#4ab4c4",
  css: "#9b59b6", scss: "#c76494", sass: "#c76494", html: "#e4704a",
  json: "#7aaa60", md: "#8aa4b4", vue: "#42b883", py: "#3572a5",
  rs: "#dea584", go: "#00add8", java: "#b07219", rb: "#701516",
  svelte: "#ff3e00",
};

function fileIcon(ext) {
  const color = EXT_COLORS[ext] || "#7a8b9a";
  return `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M2 2h6l3 3v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="${color}22" stroke="${color}" stroke-width="0.7"/>
    <path d="M8 2v3h3" stroke="${color}" stroke-width="0.7" fill="none"/>
  </svg>`;
}

// ── Language detection ────────────────────────────────────────────────────────

const EXT_TO_PRISM = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript",
  jsx: "jsx", tsx: "tsx",
  css: "css", scss: "scss", sass: "scss",
  html: "markup", htm: "markup", xml: "markup", svg: "markup",
  json: "json", jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash",
  yaml: "yaml", yml: "yaml",
  graphql: "graphql", gql: "graphql",
  vue: "markup",          // close enough
  svelte: "markup",
  md: "markdown",
};

const LANG_LABELS = {
  javascript: "JS", typescript: "TS", jsx: "JSX", tsx: "TSX",
  css: "CSS", scss: "SCSS", markup: "HTML", json: "JSON",
  python: "PY", rust: "RS", go: "GO", java: "JAVA",
  kotlin: "KT", bash: "SH", yaml: "YAML", graphql: "GQL",
  markdown: "MD",
};

function detectLang(path) {
  const ext = path.split(".").pop().toLowerCase();
  return EXT_TO_PRISM[ext] || null;
}

// ── File selection / preview ──────────────────────────────────────────────────

function selectFile(path) {
  state.selectedPath = path;

  // Update selected class
  document.querySelectorAll(".tree-node.selected").forEach((n) => n.classList.remove("selected"));
  const row = document.querySelector(`.tree-node[data-path="${CSS.escape(path)}"]`);
  if (row) row.classList.add("selected");

  const entry = state.sourceTree[path];
  if (!entry) return;

  el.previewFilename.textContent = path;
  el.previewActions.style.display = "flex";

  if (entry.content != null) {
    el.previewPlaceholder.style.display = "none";
    el.previewCode.style.display = "block";

    const lang = detectLang(path);
    const langClass = lang ? `language-${lang}` : "language-plaintext";

    // Set language class on <code>
    el.previewCodeContent.className = langClass;
    // Set text content (Prism will escape HTML internally)
    el.previewCodeContent.textContent = entry.content;

    // Trigger Prism highlight
    if (window.Prism) {
      Prism.highlightElement(el.previewCodeContent);
    }

    // Footer
    const lines = entry.content.split("\n").length;
    const bytes = new TextEncoder().encode(entry.content).length;
    el.previewLangBadge.textContent = (lang && LANG_LABELS[lang]) || (path.split(".").pop().toUpperCase());
    el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(bytes)}`;
    el.previewFooter.style.display = "flex";
  } else {
    el.previewPlaceholder.style.display = "flex";
    el.previewPlaceholder.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <path d="M8 4h10l6 6v18H8V4z" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
        <path d="M18 4v6h6" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
      </svg>
      <span style="color: var(--text-dim); font-size: 11px;">No source content embedded in map</span>
      <span style="color: var(--text-dim); font-size: 10px; font-family: var(--font-mono)">${escapeHtml(entry.sourceURL || "")}</span>
    `;
    el.previewCode.style.display = "none";
    el.previewFooter.style.display = "none";
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────

function showContextMenu(x, y, targetType) {
  el.contextMenu.style.display = "block";
  el.ctxExportFile.style.display = targetType === "file" ? "block" : "none";
  el.ctxExportDir.style.display = targetType === "dir" ? "block" : "none";

  // Clamp to viewport
  const menuW = 180, menuH = 90;
  const safeX = Math.min(x, window.innerWidth - menuW - 4);
  const safeY = Math.min(y, window.innerHeight - menuH - 4);
  el.contextMenu.style.left = safeX + "px";
  el.contextMenu.style.top = safeY + "px";
}

function hideContextMenu() {
  el.contextMenu.style.display = "none";
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

// ── Export logic ──────────────────────────────────────────────────────────────

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

async function exportFiles(paths, archiveName) {
  const format = el.formatSelect.value;
  showProgress(`Building ${format.toUpperCase()} archive...`);

  const files = paths
    .map((p) => ({ path: p, ...state.sourceTree[p] }))
    .filter((f) => f.content != null);

  if (files.length === 0) {
    hideProgress();
    alert("No exportable files found (none had embedded source content).");
    return;
  }

  if (format === "zip") {
    await exportZip(files, archiveName);
  } else {
    await exportTar(files, archiveName);
  }

  hideProgress();
}

async function exportZip(files, name) {
  const zip = new JSZip();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 90, f.path);
    zip.file(f.path, f.content);
    // Yield to keep UI responsive
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
  // Simple ustar TAR implementation (no compression — output .tar)
  const chunks = [];
  let total = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 95, f.path);

    const encoded = new TextEncoder().encode(f.content);
    const header = makeTarHeader(f.path, encoded.length);
    chunks.push(header);
    total += 512;

    // Data blocks (512-byte aligned)
    const padded = paddedBlock(encoded);
    chunks.push(padded);
    total += padded.length;

    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // Two 512-byte zero blocks at end
  chunks.push(new Uint8Array(1024));
  total += 1024;

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

function makeTarHeader(filePath, fileSize) {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();

  function write(offset, str, maxLen) {
    const bytes = enc.encode(str.slice(0, maxLen));
    header.set(bytes, offset);
  }

  // Limit path to 100 chars (ustar can do prefix but keep it simple)
  const name = filePath.slice(-100);
  write(0, name, 100);
  write(100, "0000644\0", 8);   // mode
  write(108, "0000000\0", 8);   // uid
  write(116, "0000000\0", 8);   // gid
  write(124, fileSize.toString(8).padStart(11, "0") + "\0", 12); // size
  write(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 12); // mtime
  header[156] = 0x30; // type = regular file
  write(257, "ustar\0", 6);     // magic
  write(263, "00", 2);          // version

  // Checksum
  header.fill(0x20, 148, 156); // spaces for checksum field during calc
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

// ── Collect paths ─────────────────────────────────────────────────────────────

function getAllPaths() {
  return Object.keys(state.sourceTree);
}

function getPathsUnderDir(dirPath) {
  return Object.keys(state.sourceTree).filter(
    (p) => p === dirPath || p.startsWith(dirPath + "/")
  );
}

function getDomainLabel() {
  try {
    const urls = Object.values(state.sourceTree).map((e) => e.scriptURL).filter(Boolean);
    if (urls.length === 0) return "sources";
    const u = new URL(urls[0]);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "sources";
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

el.btnConnect.addEventListener("click", async () => {
  await connect();
});

el.btnRefresh.addEventListener("click", refreshTree);

el.btnExportAll.addEventListener("click", () => {
  exportFiles(getAllPaths(), getDomainLabel());
});

el.btnExportFile.addEventListener("click", () => {
  if (!state.selectedPath) return;
  exportFiles([state.selectedPath], state.selectedPath.split("/").pop());
});

el.btnCopy.addEventListener("click", async () => {
  const entry = state.selectedPath && state.sourceTree[state.selectedPath];
  if (!entry || entry.content == null) return;
  try {
    await navigator.clipboard.writeText(entry.content);
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
  el.previewCode.classList.toggle("wrap-mode", wrapEnabled);
  el.btnWrap.classList.toggle("active", wrapEnabled);
});

el.filterInput.addEventListener("input", () => {
  state.filterText = el.filterInput.value.trim();
  if (state.treeModel) renderTree();
});

el.ctxExportFile.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "file") {
    exportFiles([state.contextTarget.path], state.contextTarget.path.split("/").pop());
  }
});

el.ctxExportDir.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "dir") {
    const paths = getPathsUnderDir(state.contextTarget.path);
    const label = state.contextTarget.path.split("/").pop();
    exportFiles(paths, label);
  }
});

el.ctxExportAll.addEventListener("click", () => {
  hideContextMenu();
  exportFiles(getAllPaths(), getDomainLabel());
});

// Auto-refresh when scripts are parsed (poll every 2s while connected)
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!state.connected) return;
    const before = Object.keys(state.sourceTree).length;
    await refreshTree();
    const after = Object.keys(state.sourceTree).length;
    // Stop polling if no new scripts for a while
    // (user can always hit refresh manually)
  }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  // Check if already attached from a previous panel open
  const res = await send({ type: "GET_SCRIPTS", tabId: state.tabId });
  if (res && res.scripts && res.scripts.length > 0) {
    state.connected = true;
    setStatus("active", "Reconnected to existing session");
    await refreshTree();
    startPolling();
  }
})();
