"use strict";

// Explorer tree: builds the folder model from flat paths and renders the
// section headers, folders and files.
// Loaded after discovery.js and capture.js, before tabs-preview.js and export.js.

// -- Tree model --

// Files sit under an optional virtual group folder (domain or file type, see groupOf) and then
// under their real folders. Real folder and file paths stay untouched, so tabs, search and
// export keep working with the same keys. With folders off, each group lists its files by
// full path.
function buildTreeModel(flat, { section }) {
  const root = { name: "", children: {}, files: {}, path: "", group: "" };
  const groupKind = groupModeFor(section);
  const nest = nestFoldersFor(section);

  for (const [filePath, data] of Object.entries(flat)) {
    let node = root;
    const group = groupOf(section, filePath, data);
    if (group) {
      node = root.children[group] ??= {
        name: groupLabelFor(section, group),
        children: {},
        files: {},
        path: "",
        group,
        isGroup: true,
        groupKind,
      };
    }

    if (!nest) {
      node.files[filePath] = { name: filePath, path: filePath, data };
      continue;
    }

    const parts = filePath.split("/").filter(Boolean);
    let currentPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: {}, path: currentPath, group };
      }
      node = node.children[part];
    }

    const filename = parts[parts.length - 1];
    node.files[filename] = { name: filename, path: filePath, data };
  }

  return root;
}

// -- Render tree --

// The tree container is an ARIA tree with roving tabindex; its listeners are at the end of this file.

const openDirs = new Set();
const userToggledDirs = new Set();

// When the user opens a directory that contains only a single subdirectory
// (no files, no sibling dirs), keep opening down that chain until a directory
// has a file or more than one entry. Only walks the chain starting at the
// directory being opened; unrelated directories are left untouched.
function expandSingleChildChain(dir, section) {
  let node = dir;
  while (Object.keys(node.files).length === 0 && Object.values(node.children).length === 1) {
    const child = Object.values(node.children)[0];
    const key = dirKey(section, child.path, child.group);
    if (userToggledDirs.has(key)) break;
    openDirs.add(key);
    node = child;
  }
}

// A site usually has exactly one group (one authored domain): open it instead of making
// the user click through a single-row level. Respects a manual collapse.
function openLoneGroup(section, model) {
  const groups = Object.values(model.children).filter((node) => node.isGroup);
  if (groups.length !== 1) return;
  const key = dirKey(section, "", groups[0].group);
  if (!userToggledDirs.has(key)) openDirs.add(key);
}

// Rows the keyboard can reach: section headers, folders and files.
const TREE_ROW_SELECTOR = ".tree-node, .tree-section-header";

const NAME_COLLATOR = new Intl.Collator();
const byName = (a, b) => NAME_COLLATOR.compare(a.name, b.name);

// Per-render caches, reset by `renderTree`. `renderedFilter` is the lowercase filter the
// DOM was built with, which lazily rendered folders reuse.
let matchCache = new Map();
let countCache = new Map();
let renderedFilter = "";

// -- Roving tabindex --
// Exactly one row is tabbable; arrow keys move focus between rows.

let treeTabStop = null;
let treeTabInfo = null;

function treeRowInfo(row) {
  if (!row) return null;
  const { type, section } = row.dataset;
  return { type, section, path: row.dataset.path ?? "", group: row.dataset.group ?? "" };
}

function findTreeRow(info) {
  if (!info) return null;
  const group = info.group ? `[data-group="${CSS.escape(info.group)}"]` : ":not([data-group])";
  return el.treeRoot.querySelector(
    `[data-type="${info.type}"][data-section="${info.section}"][data-path="${CSS.escape(info.path)}"]${group}`
  );
}

function setTreeTabStop(row) {
  if (treeTabStop?.isConnected && treeTabStop !== row) treeTabStop.tabIndex = -1;
  row.tabIndex = 0;
  treeTabStop = row;
  treeTabInfo = treeRowInfo(row);
}

// After a re-render: keep the tab stop on the same row (else the selected one, else the
// first) and put focus back if it was inside the tree.
function restoreTreeFocus(focusInfo) {
  treeTabStop = null;
  const stop =
    findTreeRow(treeTabInfo) ||
    el.treeRoot.querySelector(".tree-node.selected") ||
    el.treeRoot.querySelector(TREE_ROW_SELECTOR);
  if (stop) setTreeTabStop(stop);
  findTreeRow(focusInfo)?.focus({ preventScroll: true });
}

// `counts` ({ mapped, raw, requests }) is the per-section item count from `rebuild`; without
// it the counts are computed here.
function renderTree(counts) {
  const filesCapturedCount =
    Object.keys(state.sourceTree).length + Object.keys(state.rawTree).length;
  if (filesCapturedCount === 0) {
    el.emptyState.style.display = "flex";
    el.treeRoot.style.display = "none";
    el.treeRoot.innerHTML = "";
    treeTabStop = null;
    return;
  }

  const focusInfo = el.treeRoot.contains(document.activeElement)
    ? treeRowInfo(document.activeElement.closest(TREE_ROW_SELECTOR))
    : null;
  el.emptyState.style.display = "none";
  el.treeRoot.style.display = "block";
  el.treeRoot.innerHTML = "";

  const filter = state.filterText.toLowerCase();
  renderedFilter = filter;
  matchCache = new Map();
  countCache = new Map();
  const sections = enabledSections();
  const showHeaders = sections.length > 1;

  for (const section of sections) {
    const model = modelFor(section);
    if (!model) continue;
    openLoneGroup(section, model);
    const count = counts?.[section] ?? getItemsInSection(section).length;
    if (showHeaders) renderSectionHeader(section, count);
    if (showHeaders && collapsedSections.has(section)) continue;
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-section-empty";
      const hiddenByFilter = state.sourceFilter.active && Object.keys(treeFor(section)).length > 0;
      empty.textContent = hiddenByFilter
        ? "No files match the source filter"
        : section === "mapped"
          ? "No source maps detected"
          : "No deployed resources captured";
      el.treeRoot.appendChild(empty);
      continue;
    }
    renderNode(model, el.treeRoot, 0, filter, section);
  }

  restoreTreeFocus(focusInfo);
}

const SECTION_ICONS = {
  mapped:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  raw: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75l5.25 2.9v5.7L8 13.25 2.75 10.35v-5.7L8 1.75zM8 7.5l5.25-2.85M8 7.5v5.75M8 7.5L2.75 4.65" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  requests:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5.5h9m0 0L9.5 3M12 5.5L9.5 8M13 10.5H4m0 0L6.5 8M4 10.5L6.5 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const FOLDER_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h6.5c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-6.5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const DOMAIN_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.9 6 3.25 3.25 0 0 1 11.5 12.5h-7z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const TYPE_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 2.5h5l6 6-5 5-6-6v-5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="5.25" cy="5.25" r="1" fill="currentColor"/></svg>';

// Domain groups get a cloud and type groups a tag. A top-level folder of the Deployed section is
// a host, so it gets the cloud too.
function dirIcon(dir, depth, section) {
  if (dir.groupKind === "type") return TYPE_ICON;
  return dir.isGroup || (depth === 0 && section === "raw") ? DOMAIN_ICON : FOLDER_ICON;
}

// Sections the user folded in the Explorer (session only).
const collapsedSections = new Set();

function renderSectionHeader(section, count) {
  const header = document.createElement("div");
  header.className = "tree-section-header";
  header.dataset.section = section;
  header.dataset.type = "section";
  header.dataset.path = "";
  const label =
    section === "mapped" ? "Authored" : section === "requests" ? "Requests" : "Deployed";
  const hint =
    section === "mapped"
      ? "Authored (source-mapped)"
      : section === "requests"
        ? "Captured requests"
        : "Deployed (raw)";
  header.title = hint;
  const collapsed = collapsedSections.has(section);
  header.classList.toggle("collapsed", collapsed);
  header.setAttribute("role", "treeitem");
  header.setAttribute("aria-level", "1");
  header.setAttribute("aria-expanded", String(!collapsed));
  header.tabIndex = -1;
  header.innerHTML = `
    <svg class="tree-section-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="tree-section-icon">${SECTION_ICONS[section] || ""}</span>
    <span class="tree-section-label">${label}</span>
    <span class="tree-section-count">${count}</span>
    <button class="tree-section-export btn btn-icon btn-ghost" type="button" title="Export ${hint}" aria-label="Export ${hint}" ${count ? "" : "disabled"}>
      <svg width="12" height="12" aria-hidden="true"><use href="#i-export"/></svg>
    </button>
  `;
  el.treeRoot.appendChild(header);
}

function renderNode(node, container, depth, filter, section) {
  const dirs = Object.values(node.children).sort(byName);
  const files = Object.values(node.files).sort(byName);

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
  let hit = matchCache.get(dir);
  if (hit !== undefined) return hit;
  hit =
    dir.name.toLowerCase().includes(filter) ||
    Object.values(dir.files).some((f) => f.path.toLowerCase().includes(filter)) ||
    Object.values(dir.children).some((child) => dirHasMatch(child, filter));
  matchCache.set(dir, hit);
  return hit;
}

// Opens or closes every folder of `section` under `basePath` ("" = everything),
// optionally limited to one `group` (a domain or file type group).
function setTreeFoldState(section, basePath, open, group) {
  const tree = filteredTreeFor(section);
  const prefix = basePath ? basePath + "/" : "";
  const mark = (key) => {
    userToggledDirs.add(key);
    if (open) openDirs.add(key);
    else openDirs.delete(key);
  };
  for (const [filePath, entry] of Object.entries(tree)) {
    if (basePath && !filePath.startsWith(prefix)) continue;
    if (group && groupOf(section, filePath, entry) !== group) continue;
    for (const ancestor of treeAncestors(section, filePath, entry)) {
      if (basePath && (!ancestor.path || ancestor.path.length < basePath.length)) continue;
      mark(dirKey(section, ancestor.path, ancestor.group));
    }
  }
  if (!basePath && !group) collapsedSections.delete(section);
  renderTree();
}

function dirKey(section, dirPath, group = "") {
  return `${section}::${group}::${dirPath}`;
}

function revealFileInTree(path, section) {
  if (section === "requests") {
    const selector = `.network-row[data-path="${CSS.escape(path)}"]`;
    let row = document.querySelector(selector);
    if (!row) {
      renderNetworkTable();
      row = document.querySelector(selector);
    }
    row?.scrollIntoView({ block: "nearest" });
    return row;
  }

  let expandedAncestor = false;
  for (const { path: dirPath, group } of treeAncestors(section, path, treeFor(section)[path])) {
    const key = dirKey(section, dirPath, group);
    if (!openDirs.has(key)) {
      openDirs.add(key);
      expandedAncestor = true;
    }
  }

  // A folded section has no rows, and with a filter active every folder is already open,
  // so neither needs a re-render.
  const sectionFolded = collapsedSections.has(section) && enabledSections().length > 1;
  if (sectionFolded) return null;

  const selector = `.tree-node[data-section="${section}"][data-path="${CSS.escape(path)}"][data-type="file"]`;
  let row = document.querySelector(selector);
  if (expandedAncestor && !renderedFilter) {
    renderTree();
    row = document.querySelector(selector);
  }
  row?.scrollIntoView({ block: "nearest" });
  return row;
}

function renderDirNode(dir, container, depth, filter, section) {
  const key = dirKey(section, dir.path, dir.group);
  const isOpen = openDirs.has(key) || (filter && filter.length > 0);
  const childCount = countDescendants(dir);

  const row = document.createElement("div");
  row.className = "tree-node";
  row.style.paddingLeft = `${8 + depth * 12}px`;
  row.dataset.path = dir.path;
  row.dataset.type = "dir";
  row.dataset.section = section;
  row.dataset.depth = depth;
  if (dir.group) row.dataset.group = dir.group;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute("aria-expanded", String(Boolean(isOpen)));
  row.tabIndex = -1;

  row.innerHTML = `
    <span class="node-toggle ${isOpen ? "open" : ""}">
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="node-icon node-icon-dir">${dirIcon(dir, depth, section)}</span>
    <span class="node-name dir-name">${highlightMatch(dir.name, filter)}</span>
    <span class="node-badge">${childCount}</span>
  `;

  const childContainer = document.createElement("div");
  childContainer.className = "tree-children";
  childContainer.setAttribute("role", "group");
  childContainer.style.display = isOpen ? "block" : "none";

  container.appendChild(row);
  container.appendChild(childContainer);

  if (isOpen) {
    renderNode(dir, childContainer, depth + 1, filter, section);
  }
}

function renderFileNode(file, container, depth, filter, section) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const isMissing = file.data && file.data.fetchStatus === "missing";
  const fileSelection = state.listSelection.files;
  const isSelected = fileSelection?.section === section && fileSelection.path === file.path;
  let cls = "tree-node";
  if (isSelected) cls += " selected";
  if (isMissing) cls += " missing";
  const row = document.createElement("div");
  row.className = cls;
  row.style.paddingLeft = `${8 + depth * 12 + 12}px`;
  row.dataset.path = file.path;
  row.dataset.type = "file";
  row.dataset.section = section;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.tabIndex = -1;
  if (isMissing) row.title = "Content unavailable — will be exported as placeholder";

  row.innerHTML = `
    <span class="node-icon">${fileIcon(ext)}</span>
    <span class="node-name">${highlightMatch(file.name, filter)}</span>
  `;

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
  let n = countCache.get(dir);
  if (n !== undefined) return n;
  n = Object.keys(dir.files).length;
  for (const child of Object.values(dir.children)) n += countDescendants(child);
  countCache.set(dir, n);
  return n;
}

// -- Delegated events and keyboard --

el.treeRoot.setAttribute("role", "tree");
el.treeRoot.setAttribute("aria-label", "Explorer");

// One set of listeners on #tree-root serves every row; rows carry data-type, data-path,
// data-section and (for dirs inside a domain or file type group) data-group.

function toggleSection(section) {
  if (collapsedSections.has(section)) collapsedSections.delete(section);
  else collapsedSections.add(section);
  renderTree();
}

function isRowOpen(row) {
  const { type, section } = row.dataset;
  if (type === "section") return !collapsedSections.has(section);
  return row.nextElementSibling?.style.display !== "none";
}

function findDirNode(section, path, group) {
  let node = modelFor(section);
  if (node && group) node = node.children[group];
  for (const part of path.split("/").filter(Boolean)) {
    if (!node) return null;
    node = node.children[part];
  }
  return node || null;
}

function toggleDirRow(row, forceOpen) {
  const section = row.dataset.section;
  const path = row.dataset.path ?? "";
  const group = row.dataset.group ?? "";
  const dir = findDirNode(section, path, group);
  const childContainer = row.nextElementSibling;
  if (!dir || !childContainer) return;
  const wasOpen = childContainer.style.display !== "none";
  const nowOpen = forceOpen ?? !wasOpen;
  if (nowOpen === wasOpen) return;
  const key = dirKey(section, path, group);
  userToggledDirs.add(key);
  childContainer.style.display = nowOpen ? "block" : "none";
  row.querySelector(".node-toggle").classList.toggle("open", nowOpen);
  row.setAttribute("aria-expanded", String(nowOpen));
  if (nowOpen) {
    openDirs.add(key);
    expandSingleChildChain(dir, section);
    if (!childContainer.hasChildNodes()) {
      renderNode(dir, childContainer, Number(row.dataset.depth) + 1, renderedFilter, section);
    }
  } else {
    openDirs.delete(key);
  }
}

function openContextMenuFor(row, x, y) {
  const { type, section } = row.dataset;
  const path = row.dataset.path ?? "";
  if (type === "section") {
    state.contextTarget = { type, path: "", section };
  } else if (type === "dir") {
    state.contextTarget = { type, path, section, group: row.dataset.group || undefined };
  } else {
    state.contextTarget = { type: "file", path, section };
    openFile(path, section);
  }
  showContextMenu(x, y, type);
}

function visibleTreeRows() {
  return [...el.treeRoot.querySelectorAll(TREE_ROW_SELECTOR)].filter(
    (row) => row.offsetParent !== null
  );
}

el.treeRoot.addEventListener("click", (event) => {
  const row = event.target.closest(TREE_ROW_SELECTOR);
  if (!row) return;
  const { type, section } = row.dataset;
  if (type === "section") {
    if (event.target.closest(".tree-section-export")) {
      exportItems(getItemsInSection(section), archiveNameForSection(section));
    } else {
      toggleSection(section);
    }
  } else if (type === "dir") {
    toggleDirRow(row);
  } else {
    openFile(row.dataset.path, section);
  }
});

el.treeRoot.addEventListener("dblclick", (event) => {
  const row = event.target.closest(".tree-node");
  if (!row || row.dataset.type !== "file") return;
  const { path, section } = row.dataset;
  openFile(path, section);
  pinTab(tabId(path, section), true);
});

el.treeRoot.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(TREE_ROW_SELECTOR);
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  openContextMenuFor(row, event.clientX, event.clientY);
});

el.treeRoot.addEventListener("focusin", (event) => {
  const row = event.target.closest(TREE_ROW_SELECTOR);
  if (row && row === event.target) setTreeTabStop(row);
});

el.treeRoot.addEventListener("keydown", (event) => {
  const row = event.target.closest(TREE_ROW_SELECTOR);
  if (!row || row !== event.target) return; // keys on the section export button stay native
  const { type, section } = row.dataset;
  const expandable = type !== "file";
  if (Keybinds.matches(event, "list.next") || Keybinds.matches(event, "list.previous")) {
    event.preventDefault();
    const rows = visibleTreeRows();
    const step = Keybinds.matches(event, "list.next") ? 1 : -1;
    rows[rows.indexOf(row) + step]?.focus();
  } else if (Keybinds.matches(event, "tree.expand") && expandable) {
    event.preventDefault();
    if (!isRowOpen(row)) {
      if (type === "section") toggleSection(section);
      else toggleDirRow(row, true);
    } else {
      const rows = visibleTreeRows();
      rows[rows.indexOf(row) + 1]?.focus();
    }
  } else if (Keybinds.matches(event, "tree.collapse")) {
    if (expandable && isRowOpen(row)) {
      event.preventDefault();
      if (type === "section") toggleSection(section);
      else toggleDirRow(row, false);
    } else if (type !== "section") {
      const parentRow = row.parentElement.closest(".tree-children")?.previousElementSibling;
      if (parentRow) {
        event.preventDefault();
        parentRow.focus();
      }
    }
  } else if (Keybinds.matches(event, "item.activate")) {
    event.preventDefault();
    if (type === "section") toggleSection(section);
    else if (type === "dir") toggleDirRow(row);
    else openFile(row.dataset.path, section);
  } else if (Keybinds.matches(event, "item.menu")) {
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    openContextMenuFor(row, rect.left + 24, rect.bottom);
  }
});
