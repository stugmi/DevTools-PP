// Panel wiring: toolbar, filter, export and search handlers, plus initial UI state.
// Loaded last, after every module and keyboard.js, so all globals it uses already exist.

"use strict";

// Trailing-edge debounce; `.cancel()` drops a pending call.
function debounced(fn, ms) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

el.btnRefresh.addEventListener("click", () => {
  resetCapture();
  scanAll();
});

function updateCollectionModeUI() {
  const active = state.collectAcrossNavigations;
  el.btnCollectionMode.classList.toggle("active", active);
  el.btnCollectionMode.setAttribute("aria-pressed", active ? "true" : "false");
  el.collectionModeLabel.textContent = active ? "Collecting" : "Collect navigations";
}

el.btnCollectionMode.addEventListener("click", () => {
  state.collectAcrossNavigations = !state.collectAcrossNavigations;
  prefs.collectAcrossNavigations = state.collectAcrossNavigations;
  savePref("collectAcrossNavigations", prefs.collectAcrossNavigations);
  updateCollectionModeUI();
  rebuild();
});

// If the active tab isn't in the workspace, open its last tab or clear the preview.
function ensureActiveTab(workspace) {
  const visible = tabsForWorkspace(workspace);
  if (visible.some((tab) => tab.id === state.activeTabId)) return;
  if (visible.length) {
    const next = visible[visible.length - 1];
    state.activeTabId = next.id;
    selectFile(next.path, next.section);
  } else {
    state.activeTabId = null;
    state.selectedPath = null;
    state.selectedSection = null;
    resetPreview();
  }
}

el.viewToggle.addEventListener("click", (event) => {
  const button = event.target.closest(".view-pill");
  if (!button) return;
  const view = button.dataset.view;
  const next = {
    showMapped: state.showMapped,
    showRaw: state.showRaw,
  };
  if (view === "mapped") next.showMapped = !next.showMapped;
  else if (view === "raw") next.showRaw = !next.showRaw;
  if (!next.showMapped && !next.showRaw) return;

  Object.assign(state, next);
  for (const item of el.viewToggle.querySelectorAll(".view-pill")) {
    const active =
      (item.dataset.view === "mapped" && state.showMapped) ||
      (item.dataset.view === "raw" && state.showRaw);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
  }

  state.tabs = state.tabs.filter((tab) => {
    if (tab.section === "mapped") return state.showMapped;
    if (tab.section === "raw") return state.showRaw;
    return true;
  });
  if (state.workspace === "files") ensureActiveTab("files");
  renderTabs();
  rebuild();
});

function updateRequestFilters() {
  state.requestFilters.domain = el.requestDomainFilter.value;
  state.requestFilters.method = el.requestMethodFilter.value;
  state.requestFilters.minDuration = el.requestTimeMin.value;
  state.requestFilters.maxDuration = el.requestTimeMax.value;
  refreshNetwork();
}

const queueRequestFilters = debounced(updateRequestFilters, 150);

el.requestDomainFilter.addEventListener("change", updateRequestFilters);
el.requestMethodFilter.addEventListener("change", updateRequestFilters);
el.requestTimeMin.addEventListener("input", queueRequestFilters);
el.requestTimeMax.addEventListener("input", queueRequestFilters);

function syncTypeFilterButtons() {
  for (const button of el.requestTypeFilters.querySelectorAll("button")) {
    const active = button.dataset.requestType === state.requestFilters.type;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

el.requestTypeFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-request-type]");
  if (!button) return;
  state.requestFilters.type = button.dataset.requestType;
  syncTypeFilterButtons();
  refreshNetwork();
});
el.requestFilterClear.addEventListener("click", () => {
  queueRequestFilters.cancel();
  state.requestFilters.domain = "";
  state.requestFilters.type = "";
  state.requestFilters.method = "";
  state.requestFilters.minDuration = "";
  state.requestFilters.maxDuration = "";
  el.requestDomainFilter.value = "";
  el.requestMethodFilter.value = "";
  el.requestTimeMin.value = "";
  el.requestTimeMax.value = "";
  syncTypeFilterButtons();
  refreshNetwork();
});

el.networkTableHeader.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort-key]");
  if (!button) return;
  const key = button.dataset.sortKey;
  if (state.requestSort.key === key) {
    state.requestSort.dir = state.requestSort.dir === "asc" ? "desc" : "asc";
  } else {
    state.requestSort.key = key;
    state.requestSort.dir = key === "name" || key === "domain" || key === "type" ? "asc" : "desc";
  }
  renderNetworkTable();
});

el.networkExport.addEventListener("click", () => {
  exportItems(getItemsInSection("requests"), archiveNameForSection("requests"));
});

el.workspaceTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".workspace-tab");
  if (!button) return;
  const ws = button.dataset.workspace;
  if (ws === state.workspace) return;
  switchWorkspace(ws);
  ensureActiveTab(ws);
  renderTabs();
});

el.requestDetailTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-request-tab]");
  if (!button) return;
  state.requestDetailTab = button.dataset.requestTab;
  showSelectedRequestTab();
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

const copyButtonHtml = el.btnCopy.innerHTML;
const COPIED_HTML = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5l2.5 3 5-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied`;
let copyTimer = null;

el.btnCopy.addEventListener("click", async () => {
  const text = state.lastPreviewText;
  if (!text) return;
  const ok = await copyTextToClipboard(text);
  el.btnCopy.classList.toggle("copy-success", ok);
  if (ok) el.btnCopy.innerHTML = COPIED_HTML;
  else el.btnCopy.textContent = "Failed";
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    el.btnCopy.classList.remove("copy-success");
    el.btnCopy.innerHTML = copyButtonHtml;
  }, 1500);
});

function syncWrapButton() {
  SourceEditor.isWrapEnabled()
    .then((on) => el.btnWrap.classList.toggle("active", on))
    .catch(() => {});
}

el.btnWrap.addEventListener("click", () => {
  SourceEditor.toggleWrap()
    .then((on) => el.btnWrap.classList.toggle("active", on))
    .catch((error) => setStatus("inactive", `Wrap failed: ${error.message}`));
});
syncWrapButton();

el.btnPretty.addEventListener("click", () => {
  if (el.btnPretty.disabled) return;
  state.prettyView = !state.prettyView;
  renderContent(state.lastPreviewOriginal, state.lastPreviewLang, state.lastPreviewBadge);
});

// Preferences (theme, fonts, formatting, export, location filter) live in the Settings panel.
el.formatSelect.value = prefs.archiveFormat;
el.formatSelect.addEventListener("change", () => {
  prefs.archiveFormat = el.formatSelect.value === "tar" ? "tar" : "zip";
  savePref("archiveFormat", prefs.archiveFormat);
});
window.AppSettings.applyEditorPreferences();

el.statusFilter.addEventListener("click", () => window.EditorSettingsPanel.open("Location Filter"));

const applyFilterText = debounced(() => {
  state.filterText = el.filterInput.value.trim();
  if (state.treeModel || state.rawTreeModel || state.requestTreeModel) renderTree();
  refreshNetwork();
}, 120);
el.filterInput.addEventListener("input", applyFilterText);

el.btnFindFile.addEventListener("click", () => SourceEditor.focusFind());
el.btnReferences.addEventListener("click", () => SourceEditor.findReferences());
el.btnSearchCollapse.addEventListener("click", () => {
  const groups = Array.from(el.workspaceSearchResults.querySelectorAll(".search-file-group"));
  const collapse = groups.some((group) => !group.classList.contains("collapsed"));
  for (const group of groups) group.classList.toggle("collapsed", collapse);
});
el.workspaceSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchWorkspace(el.workspaceSearchInput.value).catch((error) => {
    el.workspaceSearchSummary.textContent = `Search failed: ${error.message}`;
  });
});
el.workspaceSearchInput.addEventListener("input", queueWorkspaceSearch);
el.workspaceSearchInput.addEventListener("keydown", (event) => {
  const activeIndex = Number(el.workspaceSearchResults.dataset.activeIndex ?? -1);
  if (Keybinds.matches(event, "list.next")) {
    event.preventDefault();
    setActiveSearchResult(activeIndex + 1);
  } else if (Keybinds.matches(event, "list.previous")) {
    event.preventDefault();
    setActiveSearchResult(activeIndex < 0 ? 0 : activeIndex - 1);
  } else if (Keybinds.matches(event, "list.accept") && activeIndex >= 0) {
    event.preventDefault();
    el.workspaceSearchResults.querySelector(".workspace-search-result.active")?.click();
  }
});

function toggleSearchOption(button, stateKey) {
  state[stateKey] = !state[stateKey];
  button.setAttribute("aria-pressed", state[stateKey] ? "true" : "false");
  queueWorkspaceSearch();
}

el.btnSearchCase.addEventListener("click", () =>
  toggleSearchOption(el.btnSearchCase, "workspaceSearchCaseSensitive")
);
el.btnSearchRegex.addEventListener("click", () =>
  toggleSearchOption(el.btnSearchRegex, "workspaceSearchRegex")
);

el.quickPickerInput.addEventListener("input", renderQuickPicker);
el.quickPickerInput.addEventListener("keydown", (event) => {
  if (Keybinds.matches(event, "list.next")) {
    event.preventDefault();
    setQuickPickerIndex(state.quickPickerIndex + 1);
  } else if (Keybinds.matches(event, "list.previous")) {
    event.preventDefault();
    setQuickPickerIndex(state.quickPickerIndex - 1);
  } else if (Keybinds.matches(event, "list.accept")) {
    event.preventDefault();
    selectQuickPickerItem(state.quickPickerIndex);
  }
});
el.quickPicker.addEventListener("mousedown", (event) => {
  if (event.target === el.quickPicker) closeQuickPicker();
});

// -- Init --

updateCollectionModeUI();
updateLocationFilterUI();
for (const btn of el.workspaceTabs.querySelectorAll(".workspace-tab")) {
  const active = btn.dataset.workspace === state.workspace;
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
}
window.PanelLayout?.init();
renderTabs();
Keybinds.applyTitles();
