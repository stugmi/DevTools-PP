"use strict";

// ── Tree model ───────────────────────────────────────────────────────────────

// With `groupByDomain`, the first level is one virtual folder per domain
// (like DevTools' Sources panel); real folder and file paths stay untouched, so
// tabs, search and export keep working with the same keys.
function buildTreeModel(flat, { groupByDomain = false } = {}) {
  const root = { name: "", children: {}, files: {}, path: "", domain: "" };

  for (const [filePath, data] of Object.entries(flat)) {
    const parts = filePath.split("/").filter(Boolean);
    let node = root;
    let domain = "";
    if (groupByDomain) {
      domain = domainOf(data);
      if (!node.children[domain]) {
        node.children[domain] = {
          name: domain,
          children: {},
          files: {},
          path: "",
          domain,
          isDomain: true,
        };
      }
      node = node.children[domain];
    }
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: {}, path: currentPath, domain };
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
const userToggledDirs = new Set();

// When the user opens a directory that contains only a single subdirectory
// (no files, no sibling dirs), keep opening down that chain of single-child
// dirs until one has a file or more than one entry. Only walks the chain
// starting at the directory being opened -- unrelated dirs elsewhere in the
// tree are left untouched.
function expandSingleChildChain(dir, section) {
  let node = dir;
  while (Object.keys(node.files).length === 0 && Object.values(node.children).length === 1) {
    const child = Object.values(node.children)[0];
    const key = dirKey(section, child.path, child.domain);
    if (userToggledDirs.has(key)) break;
    openDirs.add(key);
    node = child;
  }
}

// A site usually has exactly one authored domain: open it instead of making
// the user click through a single-row level. Respects a manual collapse.
function openLoneDomain(section, model) {
  const domains = Object.values(model.children).filter((node) => node.isDomain);
  if (domains.length !== 1) return;
  const key = dirKey(section, "", domains[0].domain);
  if (!userToggledDirs.has(key)) openDirs.add(key);
}

function renderTree() {
  const filesCapturedCount =
    Object.keys(state.sourceTree).length + Object.keys(state.rawTree).length;
  if (filesCapturedCount === 0) {
    el.emptyState.style.display = "flex";
    el.treeRoot.style.display = "none";
    el.treeRoot.innerHTML = "";
    renderNetworkTable();
    return;
  }

  el.emptyState.style.display = "none";
  el.treeRoot.style.display = "block";
  el.treeRoot.innerHTML = "";

  const filter = state.filterText.toLowerCase();
  const sections = enabledSections();
  const showHeaders = sections.length > 1;

  for (const section of sections) {
    const model = modelFor(section);
    if (!model) continue;
    openLoneDomain(section, model);
    const count = getItemsInSection(section).length;
    if (showHeaders) renderSectionHeader(section, count);
    if (showHeaders && collapsedSections.has(section)) continue;
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-section-empty";
      empty.textContent =
        section === "mapped" ? "No source maps detected" : "No deployed resources captured";
      el.treeRoot.appendChild(empty);
      continue;
    }
    renderNode(model, el.treeRoot, 0, filter, section);
  }

  renderNetworkTable();
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

// Sections the user folded in the Explorer (session only).
const collapsedSections = new Set();

function renderSectionHeader(section, count) {
  const header = document.createElement("div");
  header.className = "tree-section-header";
  header.dataset.section = section;
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
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", String(!collapsed));
  header.tabIndex = 0;
  header.innerHTML = `
    <svg class="tree-section-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="tree-section-icon">${SECTION_ICONS[section] || ""}</span>
    <span class="tree-section-label">${label}</span>
    <span class="tree-section-count">${count}</span>
    <button class="tree-section-export btn btn-icon btn-ghost" type="button" title="Export ${hint}" aria-label="Export ${hint}" ${count ? "" : "disabled"}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  `;
  const toggle = () => {
    if (collapsedSections.has(section)) collapsedSections.delete(section);
    else collapsedSections.add(section);
    renderTree();
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (event) => {
    if (event.target === header && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      toggle();
    }
  });
  header.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.contextTarget = { type: "section", path: "", section };
    showContextMenu(event.clientX, event.clientY, "section");
  });
  header.querySelector(".tree-section-export").addEventListener("click", (event) => {
    event.stopPropagation();
    exportItems(getItemsInSection(section), archiveNameForSection(section));
  });
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

// Opens or closes every folder of `section` under `basePath` ("" = everything),
// optionally limited to one `domain` (Authored is grouped by domain).
function setTreeFoldState(section, basePath, open, domain) {
  const tree = filteredTreeFor(section);
  const prefix = basePath ? basePath + "/" : "";
  const grouped = section === "mapped";
  const mark = (key) => {
    userToggledDirs.add(key);
    if (open) openDirs.add(key);
    else openDirs.delete(key);
  };
  for (const [filePath, entry] of Object.entries(tree)) {
    if (basePath && !filePath.startsWith(prefix)) continue;
    const entryDomain = grouped ? domainOf(entry) : "";
    if (domain && entryDomain !== domain) continue;
    if (grouped && !basePath) mark(dirKey(section, "", entryDomain));
    let dirPath = "";
    for (const part of filePath.split("/").filter(Boolean).slice(0, -1)) {
      dirPath += (dirPath ? "/" : "") + part;
      if (basePath && dirPath.length < basePath.length) continue;
      mark(dirKey(section, dirPath, entryDomain));
    }
  }
  if (!basePath && !domain) collapsedSections.delete(section);
  renderTree();
}

function dirKey(section, dirPath, domain = "") {
  return `${section}::${domain}::${dirPath}`;
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

  const parts = path.split("/").filter(Boolean);
  const domain = section === "mapped" ? domainOf(treeFor(section)[path]) : "";
  let dirPath = "";
  let expandedAncestor = false;
  if (domain) {
    const domainKey = dirKey(section, "", domain);
    if (!openDirs.has(domainKey)) {
      openDirs.add(domainKey);
      expandedAncestor = true;
    }
  }
  for (const part of parts.slice(0, -1)) {
    dirPath += (dirPath ? "/" : "") + part;
    const key = dirKey(section, dirPath, domain);
    if (!openDirs.has(key)) {
      openDirs.add(key);
      expandedAncestor = true;
    }
  }

  const selector = `.tree-node[data-section="${section}"][data-path="${CSS.escape(path)}"][data-type="file"]`;
  let row = document.querySelector(selector);
  if (expandedAncestor || !row) {
    renderTree();
    row = document.querySelector(selector);
  }
  row?.scrollIntoView({ block: "nearest" });
  return row;
}

function renderDirNode(dir, container, depth, filter, section) {
  const key = dirKey(section, dir.path, dir.domain);
  const isOpen = openDirs.has(key) || (filter && filter.length > 0);
  const childCount = countDescendants(dir);

  const row = document.createElement("div");
  row.className = "tree-node";
  row.style.paddingLeft = `${8 + depth * 12}px`;
  row.dataset.path = dir.path;
  row.dataset.type = "dir";
  row.dataset.section = section;
  if (dir.domain) row.dataset.domain = dir.domain;

  row.innerHTML = `
    <span class="node-toggle ${isOpen ? "open" : ""}">
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span class="node-icon node-icon-dir">${depth === 0 ? DOMAIN_ICON : FOLDER_ICON}</span>
    <span class="node-name dir-name">${highlightMatch(dir.name, filter)}</span>
    <span class="node-badge">${childCount}</span>
  `;

  const childContainer = document.createElement("div");
  childContainer.className = "tree-children";
  childContainer.style.display = isOpen ? "block" : "none";

  let childrenRendered = isOpen;

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    userToggledDirs.add(key);
    const nowOpen = childContainer.style.display === "none";
    childContainer.style.display = nowOpen ? "block" : "none";
    row.querySelector(".node-toggle").classList.toggle("open", nowOpen);
    if (nowOpen) {
      openDirs.add(key);
      expandSingleChildChain(dir, section);
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
    state.contextTarget = { type: "dir", path: dir.path, section, domain: dir.domain || undefined };
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
  row.style.paddingLeft = `${8 + depth * 12 + 12}px`;
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
