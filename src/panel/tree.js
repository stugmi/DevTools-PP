"use strict";

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
    const key = dirKey(section, child.path);
    if (userToggledDirs.has(key)) break;
    openDirs.add(key);
    node = child;
  }
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
    const count = getItemsInSection(section).length;
    if (showHeaders) renderSectionHeader(section, count);
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

function renderSectionHeader(section, count) {
  const header = document.createElement("div");
  header.className = "tree-section-header";
  header.dataset.section = section;
  const label =
    section === "mapped"
      ? "Authored (source-mapped)"
      : section === "requests"
        ? "Requests"
        : "Deployed (raw)";
  header.innerHTML = `
    <span class="tree-section-label">${label}</span>
    <span class="tree-section-actions">
      <span class="tree-section-count">${count}</span>
      <button class="tree-section-export" type="button" ${count ? "" : "disabled"}>
        Export
      </button>
    </span>
  `;
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

function dirKey(section, dirPath) {
  return section + "::" + dirPath;
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
  let dirPath = "";
  let expandedAncestor = false;
  for (const part of parts.slice(0, -1)) {
    dirPath += (dirPath ? "/" : "") + part;
    const key = dirKey(section, dirPath);
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
