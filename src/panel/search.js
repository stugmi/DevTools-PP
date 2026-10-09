"use strict";

async function getWorkspaceDocuments() {
  const items = [];
  for (const section of ["mapped", "raw", "requests"]) {
    for (const path of Object.keys(treeFor(section))) items.push({ path, section });
  }

  await Promise.all(
    items.map(async (item) => {
      const entry = treeFor(item.section)[item.path];
      if (
        entry &&
        entry.content == null &&
        entry.fetchStatus !== "missing" &&
        isTextEntry(item.path, entry) &&
        entry.sourceURL &&
        !entry.sourceURL.startsWith("data:")
      ) {
        const content = await loadRawByURL(entry.sourceURL, entry._resource);
        if (content != null) {
          entry.content = content;
          entry.fetchStatus = "ok";
        }
      }
    })
  );

  return items.flatMap((item) => {
    const entry = treeFor(item.section)[item.path];
    if (!entry || typeof entry.content !== "string" || !isTextEntry(item.path, entry)) return [];
    return [
      {
        id: tabId(item.path, item.section),
        path: item.path,
        section: item.section,
        content: entry.content,
        language: detectEntryLang(item.path, entry) || "plaintext",
      },
    ];
  });
}

function updateEditedDocument(editorDocument, content) {
  const entry = treeFor(editorDocument.section)[editorDocument.path];
  if (!entry) return;
  entry.content = content;
  entry.fetchStatus = "ok";
  state.lastPreviewOriginal = content;
  state.lastPreviewText = content;
  const tab = state.tabs.find((item) => item.id === editorDocument.id);
  if (tab && !tab.dirty) {
    tab.dirty = true;
    renderTabs();
  }
  const lines = content.split("\n").length;
  const bytes = new TextEncoder().encode(content).length;
  el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(bytes)} · modified`;
}

SourceEditor.configure({
  getDocuments: getWorkspaceDocuments,
  onChange: updateEditedDocument,
  openDocument(id, position) {
    const separator = id.indexOf("::");
    if (separator === -1) return;
    openFile(id.slice(separator + 2), id.slice(0, separator), position);
  },
});

// The search results live in a dockable sidebar view (see layout.js).
const SEARCH_HINT = "Search Authored, Deployed, and Requests.";

function setWorkspaceSearchOpen(open) {
  if (!open) {
    window.PanelLayout.hideView("search");
    return;
  }
  window.PanelLayout.showView("search");
  // Like VS Code: seed the box with the editor's current selection.
  SourceEditor.getSelectedText()
    .then((selected) => {
      if (selected && !/[\r\n]/.test(selected)) {
        el.workspaceSearchInput.value = selected;
        queueWorkspaceSearch();
      }
    })
    .catch(() => {})
    .finally(() => {
      el.workspaceSearchInput.focus();
      el.workspaceSearchInput.select();
    });
}

function escapeSearchPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchPattern(query) {
  const source = state.workspaceSearchRegex ? query : escapeSearchPattern(query);
  return new RegExp(source, state.workspaceSearchCaseSensitive ? "g" : "gi");
}

function searchLine(pattern, line) {
  const matches = [];
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const length = Math.max(match[0].length, 1);
    matches.push({ column: match.index + 1, length });
    if (match[0].length === 0) pattern.lastIndex = match.index + 1;
  }
  return matches;
}

function searchSnippet(text, column, length) {
  const index = column - 1;
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 110);
  const before = text.slice(start, index);
  const hit = text.slice(index, index + length);
  const after = text.slice(index + length, end);
  return `${start ? "…" : ""}${escapeHtml(before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}${end < text.length ? "…" : ""}`;
}

function openSearchMatch(match) {
  const position = formattedSearchPosition(match) || {
    line: match.line,
    column: match.column,
    endColumn: match.column + match.length,
  };
  openFile(match.editorDocument.path, match.editorDocument.section, position);
}

function offsetForLineColumn(content, line, column) {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const nextLine = content.indexOf("\n", offset);
    if (nextLine === -1) return content.length;
    offset = nextLine + 1;
    currentLine++;
  }
  return Math.min(content.length, offset + Math.max(0, column - 1));
}

function positionForOffset(content, offset) {
  const before = content.slice(0, Math.max(0, Math.min(offset, content.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function mapOffsetIgnoringWhitespace(source, formatted, targetOffset) {
  let sourceOffset = 0;
  let formattedOffset = 0;
  const whitespace = /\s/;
  while (
    sourceOffset < targetOffset &&
    sourceOffset < source.length &&
    formattedOffset < formatted.length
  ) {
    if (source[sourceOffset] === formatted[formattedOffset]) {
      sourceOffset++;
      formattedOffset++;
      continue;
    }
    if (whitespace.test(source[sourceOffset])) {
      while (sourceOffset < targetOffset && whitespace.test(source[sourceOffset])) sourceOffset++;
      while (formattedOffset < formatted.length && whitespace.test(formatted[formattedOffset])) {
        formattedOffset++;
      }
      continue;
    }
    if (whitespace.test(formatted[formattedOffset])) {
      formattedOffset++;
      continue;
    }
    const nextFormatted = formatted.indexOf(source[sourceOffset], formattedOffset + 1);
    const nextSource = source.indexOf(formatted[formattedOffset], sourceOffset + 1);
    const formattedDistance = nextFormatted === -1 ? Infinity : nextFormatted - formattedOffset;
    const sourceDistance = nextSource === -1 ? Infinity : nextSource - sourceOffset;
    if (formattedDistance <= sourceDistance && formattedDistance < 256) {
      formattedOffset = nextFormatted;
    } else if (sourceDistance < 256) {
      sourceOffset = Math.min(nextSource, targetOffset);
    } else {
      sourceOffset++;
      formattedOffset++;
    }
  }
  return Math.min(formatted.length, formattedOffset + Math.max(0, targetOffset - sourceOffset));
}

function formattedSearchPosition(match) {
  if (!state.prettyView || !canPrettyFormat(match.editorDocument.language)) return null;
  const formatted = tryPretty(match.editorDocument.content, match.editorDocument.language);
  if (!formatted.ok) return null;

  const pattern = new RegExp(match.patternSource, match.patternFlags);
  let ordinal = 0;
  const lines = formatted.content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    for (const lineMatch of searchLine(pattern, lines[lineIndex])) {
      if (ordinal === match.ordinal) {
        return {
          line: lineIndex + 1,
          column: lineMatch.column,
          endColumn: lineMatch.column + lineMatch.length,
          formattedContent: formatted.content,
        };
      }
      ordinal++;
    }
  }

  const rawStart = offsetForLineColumn(match.editorDocument.content, match.line, match.column);
  const rawEnd = rawStart + match.length;
  const formattedStart = mapOffsetIgnoringWhitespace(
    match.editorDocument.content,
    formatted.content,
    rawStart
  );
  const formattedEnd = mapOffsetIgnoringWhitespace(
    match.editorDocument.content,
    formatted.content,
    rawEnd
  );
  const start = positionForOffset(formatted.content, formattedStart);
  const end = positionForOffset(formatted.content, formattedEnd);
  if (start.line !== end.line)
    return { ...start, endColumn: start.column, formattedContent: formatted.content };
  return {
    ...start,
    endColumn: Math.max(start.column, end.column),
    formattedContent: formatted.content,
  };
}

function setActiveSearchResult(index) {
  const results = Array.from(
    el.workspaceSearchResults.querySelectorAll(".workspace-search-result")
  );
  if (!results.length) return;
  const next = Math.max(0, Math.min(index, results.length - 1));
  results.forEach((result, resultIndex) => result.classList.toggle("active", resultIndex === next));
  results[next].scrollIntoView({ block: "nearest" });
  el.workspaceSearchResults.dataset.activeIndex = String(next);
}

let workspaceSearchRequest = 0;

async function searchWorkspace(query) {
  const request = ++workspaceSearchRequest;
  const needle = query.trim();
  el.workspaceSearchResults.innerHTML = "";
  delete el.workspaceSearchResults.dataset.activeIndex;
  if (!needle) {
    el.workspaceSearchSummary.textContent = SEARCH_HINT;
    return;
  }

  el.workspaceSearchSummary.textContent = "Loading website files…";
  const documents = await getWorkspaceDocuments();
  if (request !== workspaceSearchRequest) return;
  let pattern;
  try {
    pattern = searchPattern(needle);
  } catch (error) {
    el.workspaceSearchSummary.textContent = `Invalid regular expression: ${error.message}`;
    return;
  }
  const matches = [];

  for (const editorDocument of documents) {
    const lines = editorDocument.content.split("\n");
    let ordinal = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      for (const lineMatch of searchLine(pattern, lines[lineIndex])) {
        matches.push({
          editorDocument,
          line: lineIndex + 1,
          column: lineMatch.column,
          length: lineMatch.length,
          text: lines[lineIndex],
          ordinal,
          patternSource: pattern.source,
          patternFlags: pattern.flags,
        });
        ordinal++;
        if (matches.length >= 500) break;
      }
      if (matches.length >= 500) break;
    }
    if (matches.length >= 500) break;
  }

  const groups = new Map();
  for (const match of matches) {
    const id = match.editorDocument.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(match);
  }
  el.workspaceSearchSummary.textContent = matches.length
    ? `${matches.length}${matches.length === 500 ? "+" : ""} matches in ${groups.size} files`
    : "No results found.";
  const fragment = document.createDocumentFragment();
  for (const groupMatches of groups.values()) {
    const editorDocument = groupMatches[0].editorDocument;
    const parts = editorDocument.path.split("/");
    const fileName = parts.pop() || editorDocument.path;
    const group = document.createElement("section");
    group.className = "search-file-group";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "search-file-header";
    header.innerHTML = `<span class="search-file-chevron">▼</span><span class="search-file-name">${escapeHtml(fileName)}</span><span class="search-file-path">${escapeHtml(parts.join("/"))} · ${escapeHtml(editorDocument.section)}</span><span class="search-file-count">${groupMatches.length}</span>`;
    header.addEventListener("click", () => group.classList.toggle("collapsed"));
    const matchContainer = document.createElement("div");
    matchContainer.className = "search-file-matches";
    for (const match of groupMatches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-search-result";
      button.innerHTML = `<span class="search-result-location">${match.line}:${match.column}</span><code>${searchSnippet(match.text, match.column, match.length)}</code>`;
      button.addEventListener("click", () => openSearchMatch(match));
      matchContainer.appendChild(button);
    }
    group.appendChild(header);
    group.appendChild(matchContainer);
    fragment.appendChild(group);
  }
  el.workspaceSearchResults.appendChild(fragment);
}

let workspaceSearchTimer = null;

function queueWorkspaceSearch() {
  clearTimeout(workspaceSearchTimer);
  workspaceSearchTimer = setTimeout(() => {
    searchWorkspace(el.workspaceSearchInput.value).catch((error) => {
      el.workspaceSearchSummary.textContent = `Search failed: ${error.message}`;
    });
  }, 120);
}

function commandPaletteItems() {
  return [
    {
      label: "Open File",
      detail: "Ctrl+P",
      run: () => openQuickPicker("files"),
    },
    {
      label: "Search: Find in All Files",
      detail: "Ctrl+Shift+H",
      run: () => setWorkspaceSearchOpen(true),
    },
    {
      label: "Search: Find in Current File",
      detail: "Ctrl+F",
      run: () => SourceEditor.focusFind(),
    },
    {
      label: "Go to Definition",
      detail: "F12 / Ctrl+Click",
      run: () => SourceEditor.goToDefinition(),
    },
    {
      label: "Find All References",
      detail: "",
      run: () => SourceEditor.findReferences(),
    },
    {
      label: "View: Toggle Word Wrap",
      detail: "",
      run: () => el.btnWrap.click(),
    },
    {
      label: "Format: Format Current File",
      detail: "Ctrl+Shift+F",
      run: () => formatCurrentFile(),
    },
    {
      label: "Preferences: Open Settings",
      detail: "Ctrl+,",
      run: () => window.EditorSettingsPanel?.open(),
    },
    {
      label: "Sources: Refresh",
      detail: "",
      run: () => el.btnRefresh.click(),
    },
    {
      label: "Export: Export Current File",
      detail: "",
      run: () => el.btnExportFile.click(),
    },
    {
      label: "Export: Export All",
      detail: "",
      run: () => el.btnExportAll.click(),
    },
    ...window.PanelLayout.commands(),
  ];
}

function quickPickerMatches(item, query) {
  if (!query) return true;
  const haystack = `${item.label} ${item.detail || ""}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part));
}

function renderQuickPicker() {
  const query = el.quickPickerInput.value.trim().replace(/^>/, "").trim();
  state.quickPickerItems = state.quickPickerAllItems.filter((item) =>
    quickPickerMatches(item, query)
  );
  state.quickPickerIndex = state.quickPickerItems.length ? 0 : -1;
  el.quickPickerResults.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const [index, item] of state.quickPickerItems.slice(0, 200).entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-picker-item";
    button.setAttribute("role", "option");
    button.classList.toggle("active", index === state.quickPickerIndex);
    button.innerHTML = `<span class="quick-picker-item-label">${escapeHtml(item.label)}</span><span class="quick-picker-item-detail">${escapeHtml(item.detail || "")}</span>`;
    button.addEventListener("click", () => selectQuickPickerItem(index));
    fragment.appendChild(button);
  }
  el.quickPickerResults.appendChild(fragment);
}

function setQuickPickerIndex(index) {
  const buttons = Array.from(el.quickPickerResults.querySelectorAll(".quick-picker-item"));
  if (!buttons.length) return;
  state.quickPickerIndex = (index + buttons.length) % buttons.length;
  buttons.forEach((button, itemIndex) =>
    button.classList.toggle("active", itemIndex === state.quickPickerIndex)
  );
  buttons[state.quickPickerIndex].scrollIntoView({ block: "nearest" });
}

function closeQuickPicker() {
  el.quickPicker.hidden = true;
  state.quickPickerMode = null;
  state.quickPickerAllItems = [];
  state.quickPickerItems = [];
  state.quickPickerIndex = -1;
}

function selectQuickPickerItem(index) {
  const item = state.quickPickerItems[index];
  if (!item) return;
  closeQuickPicker();
  item.run();
}

let quickPickerRequest = 0;

async function openQuickPicker(mode) {
  const request = ++quickPickerRequest;
  state.quickPickerMode = mode;
  el.quickPicker.hidden = false;
  el.quickPickerTitle.textContent = mode === "commands" ? "Command Palette" : "Open File";
  el.quickPickerHint.textContent = mode === "commands" ? "Ctrl+Shift+P" : "Ctrl+P";
  el.quickPickerInput.placeholder = mode === "commands" ? "Type a command…" : "Type a file name…";
  el.quickPickerInput.value = "";
  el.quickPickerResults.innerHTML = "";
  if (mode === "commands") {
    state.quickPickerAllItems = commandPaletteItems();
  } else {
    state.quickPickerAllItems = ALL_SECTIONS.flatMap((section) =>
      Object.keys(treeFor(section)).map((path) => ({
        label: path.split("/").pop() || path,
        detail: `${path} · ${section}`,
        run: () => openFile(path, section),
      }))
    );
  }
  if (request !== quickPickerRequest || state.quickPickerMode !== mode) return;
  renderQuickPicker();
  el.quickPickerInput.focus();
}
