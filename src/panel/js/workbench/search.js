"use strict";

// Workspace search, editor document loading, and the command palette / quick picker.
// Loaded after tabs-preview.js (uses openFile, renderTabs); PanelLayout is used at call time.

async function getWorkspaceDocuments() {
  const items = [];
  for (const section of ["mapped", "raw", "requests"]) {
    for (const path of Object.keys(treeFor(section))) items.push({ path, section });
  }

  // Bounded (6 at a time); failures are marked missing, so they are fetched once per capture.
  await ensureContent(
    items.flatMap((item) => {
      const entry = treeFor(item.section)[item.path];
      return entry && isTextEntry(item.path, entry) ? [entry] : [];
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

// Called (debounced) by the editor after the user edits a document. `stats` carries the
// model's line count and character length so the content is not re-scanned here.
function updateEditedDocument(editorDocument, content, stats) {
  const entry = treeFor(editorDocument.section)[editorDocument.path];
  if (!entry) return;
  entry.content = content;
  entry.fetchStatus = "ok";
  entry.edited = true;
  state.lastPreviewOriginal = content;
  state.lastPreviewText = content;
  const tab = state.tabs.find((item) => item.id === editorDocument.id);
  if (tab && (!tab.dirty || !tab.pinned)) {
    tab.dirty = true;
    tab.pinned = true;
    renderTabs();
  }
  const lines = stats?.lines ?? content.split("\n").length;
  const size = stats?.length ?? content.length;
  el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(size)} · modified`;
}

// Authored (source-mapped) JS/TS files that already have their content, for the
// editor's virtual TypeScript project. Synchronous and cheap: it never fetches,
// and skips node_modules and anything huge.
function getAuthoredDocuments() {
  const docs = [];
  for (const [path, entry] of Object.entries(state.sourceTree)) {
    if (typeof entry.content !== "string" || entry.content.length > 400_000) continue;
    if (/(^|\/)node_modules\//.test(path)) continue;
    const language = detectEntryLang(path, entry);
    if (language !== "typescript" && language !== "javascript") continue;
    docs.push({
      id: tabId(path, "mapped"),
      path,
      section: "mapped",
      content: entry.content,
      language,
    });
  }
  return docs;
}

SourceEditor.configure({
  getDocuments: getWorkspaceDocuments,
  getAuthoredDocuments,
  onChange: updateEditedDocument,
  isDocumentOpen: (id) => state.tabs.some((tab) => tab.id === id),
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

// Matches on one line, stopping at `limit`. `pattern` must have the g flag.
function searchLine(pattern, line, limit = Infinity) {
  const matches = [];
  pattern.lastIndex = 0;
  let match;
  while (matches.length < limit && (match = pattern.exec(line))) {
    matches.push({ column: match.index + 1, length: Math.max(match[0].length, 1) });
    if (match[0].length === 0) pattern.lastIndex++;
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

const MAX_SEARCH_RESULTS = 500;

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
  let lastYield = performance.now();

  for (const editorDocument of documents) {
    // Yield now and then so typing stays responsive; a newer query cancels this one.
    if (performance.now() - lastYield > 30) {
      await new Promise((resolve) => setTimeout(resolve));
      if (request !== workspaceSearchRequest) return;
      lastYield = performance.now();
    }
    const content = editorDocument.content;
    let ordinal = 0;
    let lineIndex = 0;
    let lineStart = 0;
    while (lineStart <= content.length && matches.length < MAX_SEARCH_RESULTS) {
      let lineEnd = content.indexOf("\n", lineStart);
      if (lineEnd === -1) lineEnd = content.length;
      const text = content.slice(lineStart, lineEnd);
      for (const lineMatch of searchLine(pattern, text, MAX_SEARCH_RESULTS - matches.length)) {
        matches.push({
          editorDocument,
          line: lineIndex + 1,
          column: lineMatch.column,
          length: lineMatch.length,
          text,
          ordinal,
          patternSource: pattern.source,
          patternFlags: pattern.flags,
        });
        ordinal++;
      }
      lineIndex++;
      lineStart = lineEnd + 1;
    }
    if (matches.length >= MAX_SEARCH_RESULTS) break;
  }

  const groups = new Map();
  for (const match of matches) {
    const id = match.editorDocument.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(match);
  }
  el.workspaceSearchSummary.textContent = matches.length
    ? `${matches.length}${matches.length === MAX_SEARCH_RESULTS ? "+" : ""} matches in ${groups.size} files`
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
      detail: Keybinds.label("palette.files"),
      run: () => openQuickPicker("files"),
    },
    {
      label: "Search: Find in All Files",
      detail: Keybinds.label("search.workspace"),
      run: () => setWorkspaceSearchOpen(true),
    },
    {
      label: "Search: Find in Current File",
      detail: Keybinds.label("editor.find"),
      run: () => SourceEditor.focusFind(),
    },
    {
      label: "Go to Definition",
      detail: Keybinds.labels("editor.goToDefinition").join(" / "),
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
      detail: Keybinds.label("file.format"),
      run: () => formatCurrentFile(),
    },
    {
      label: "Preferences: Open Settings",
      detail: Keybinds.label("settings.toggle"),
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
    ...(window.EditorSettingsPanel?.commands() ?? []),
  ];
}

// `parts` are the lowercase query words; `item.haystack` is lowercased once when items are built.
function quickPickerMatches(item, parts) {
  return parts.every((part) => item.haystack.includes(part));
}

function quickPickerOptionId(index) {
  return `quick-picker-opt-${index}`;
}

function syncQuickPickerActiveDescendant() {
  if (state.quickPickerIndex >= 0 && state.quickPickerItems.length) {
    el.quickPickerInput.setAttribute(
      "aria-activedescendant",
      quickPickerOptionId(state.quickPickerIndex)
    );
  } else {
    el.quickPickerInput.removeAttribute("aria-activedescendant");
  }
}

function renderQuickPicker() {
  const query = el.quickPickerInput.value.trim().replace(/^>/, "").trim();
  const parts = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  state.quickPickerItems = state.quickPickerAllItems.filter((item) =>
    quickPickerMatches(item, parts)
  );
  state.quickPickerIndex = state.quickPickerItems.length ? 0 : -1;
  el.quickPickerResults.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const [index, item] of state.quickPickerItems.slice(0, 200).entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-picker-item";
    button.id = quickPickerOptionId(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === state.quickPickerIndex));
    button.classList.toggle("active", index === state.quickPickerIndex);
    button.innerHTML = `<span class="quick-picker-item-label">${escapeHtml(item.label)}</span><span class="quick-picker-item-detail">${escapeHtml(item.detail || "")}</span>`;
    button.addEventListener("click", () => selectQuickPickerItem(index));
    fragment.appendChild(button);
  }
  el.quickPickerResults.appendChild(fragment);
  syncQuickPickerActiveDescendant();
}

function setQuickPickerIndex(index) {
  const buttons = Array.from(el.quickPickerResults.querySelectorAll(".quick-picker-item"));
  if (!buttons.length) return;
  state.quickPickerIndex = (index + buttons.length) % buttons.length;
  buttons.forEach((button, itemIndex) => {
    const active = itemIndex === state.quickPickerIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  buttons[state.quickPickerIndex].scrollIntoView({ block: "nearest" });
  syncQuickPickerActiveDescendant();
}

let quickPickerReturnFocus = null;

function closeQuickPicker() {
  el.quickPicker.hidden = true;
  state.quickPickerMode = null;
  state.quickPickerAllItems = [];
  state.quickPickerItems = [];
  state.quickPickerIndex = -1;
  el.quickPickerInput.removeAttribute("aria-activedescendant");
  // Hand focus back first; a selected item's action may then move it elsewhere.
  if (quickPickerReturnFocus?.isConnected) quickPickerReturnFocus.focus();
  quickPickerReturnFocus = null;
}

function selectQuickPickerItem(index) {
  const item = state.quickPickerItems[index];
  if (!item) return;
  closeQuickPicker();
  item.run();
}

function openQuickPicker(mode) {
  if (el.quickPicker.hidden) quickPickerReturnFocus = document.activeElement;
  state.quickPickerMode = mode;
  el.quickPicker.hidden = false;
  el.quickPickerTitle.textContent = mode === "commands" ? "Command Palette" : "Open File";
  el.quickPickerHint.textContent = Keybinds.label(
    mode === "commands" ? "palette.commands" : "palette.files"
  );
  el.quickPickerInput.placeholder = mode === "commands" ? "Type a command…" : "Type a file name…";
  el.quickPickerInput.value = "";
  el.quickPickerResults.innerHTML = "";
  const items =
    mode === "commands"
      ? commandPaletteItems()
      : ALL_SECTIONS.flatMap((section) =>
          Object.keys(treeFor(section)).map((path) => ({
            label: path.split("/").pop() || path,
            detail: `${path} · ${section}`,
            run: () => openFile(path, section),
          }))
        );
  state.quickPickerAllItems = items.map((item) => ({
    ...item,
    haystack: `${item.label} ${item.detail || ""}`.toLocaleLowerCase(),
  }));
  renderQuickPicker();
  el.quickPickerInput.focus();
}
