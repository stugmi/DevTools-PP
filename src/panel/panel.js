"use strict";

el.btnRefresh.addEventListener("click", () => {
  resetCapture();
  scheduleScriptScan(0);
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
  if (
    state.workspace === "files" &&
    !tabsForWorkspace("files").find((tab) => tab.id === state.activeTabId)
  ) {
    const visible = tabsForWorkspace("files");
    if (visible.length) {
      const nextTab = visible[visible.length - 1];
      state.activeTabId = nextTab.id;
      selectFile(nextTab.path, nextTab.section);
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

function updateRequestFilters() {
  state.requestFilters.domain = el.requestDomainFilter.value;
  state.requestFilters.method = el.requestMethodFilter.value;
  state.requestFilters.minDuration = el.requestTimeMin.value;
  state.requestFilters.maxDuration = el.requestTimeMax.value;
  rebuild();
}

el.requestDomainFilter.addEventListener("change", updateRequestFilters);
el.requestMethodFilter.addEventListener("change", updateRequestFilters);
el.requestTimeMin.addEventListener("input", updateRequestFilters);
el.requestTimeMax.addEventListener("input", updateRequestFilters);
function syncTypeFilterButtons() {
  for (const button of el.requestTypeFilters.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.requestType === state.requestFilters.type);
  }
}

el.requestTypeFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-request-type]");
  if (!button) return;
  state.requestFilters.type = button.dataset.requestType;
  syncTypeFilterButtons();
  rebuild();
});
el.requestFilterClear.addEventListener("click", () => {
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
  rebuild();
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
  const visible = tabsForWorkspace(ws);
  if (!visible.find((t) => t.id === state.activeTabId)) {
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
  SourceEditor.toggleWrap(wrapEnabled).catch(() => {});
  el.btnWrap.classList.toggle("active", wrapEnabled);
});

el.btnPretty.addEventListener("click", () => {
  if (el.btnPretty.disabled) return;
  state.prettyView = !state.prettyView;
  renderContent(state.lastPreviewOriginal, state.lastPreviewLang, state.lastPreviewBadge);
});

// All preferences (theme, fonts, formatting, export, location filter) live in
// the unified Settings panel -- see app-settings.js / editor-settings.js.
el.formatSelect.value = prefs.archiveFormat;
el.formatSelect.addEventListener("change", () => {
  prefs.archiveFormat = el.formatSelect.value === "tar" ? "tar" : "zip";
  savePref("archiveFormat", prefs.archiveFormat);
});
window.AppSettings.applyEditorPreferences();

el.statusFilter.addEventListener("click", () => window.EditorSettingsPanel.open("Location Filter"));

el.filterInput.addEventListener("input", () => {
  state.filterText = el.filterInput.value.trim();
  if (state.treeModel || state.rawTreeModel || state.requestTreeModel) renderTree();
});

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
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveSearchResult(activeIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveSearchResult(activeIndex < 0 ? 0 : activeIndex - 1);
  } else if (event.key === "Enter" && activeIndex >= 0) {
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
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setQuickPickerIndex(state.quickPickerIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setQuickPickerIndex(state.quickPickerIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    selectQuickPickerItem(state.quickPickerIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeQuickPicker();
  }
});
el.quickPicker.addEventListener("mousedown", (event) => {
  if (event.target === el.quickPicker) closeQuickPicker();
});

function swallowShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

// ── Keyboard navigation ──────────────────────────────────────────────────────
// Modelled on DevTools: Esc dismisses one layer at a time (menu, settings
// window, request view) and only falls through -- unhandled, so DevTools
// toggles its drawer -- once nothing is left to dismiss. Up/Down walk the
// request list and Alt+Left/Right cycle the tabs of whichever view is in front.

const IS_MAC = /mac/i.test(navigator.platform);
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

// True for controls that use the arrow keys / Esc themselves. Read-only inputs
// (the request URL field) don't count.
function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && !target.readOnly && !NON_TEXT_INPUT_TYPES.has(target.type)
  );
}

// A Monaco widget (find, suggestions, parameter hints) that should get the
// Esc keypress before anything behind it is dismissed.
function monacoWidgetOpen(target) {
  const editor = target instanceof Element ? target.closest(".monaco-editor") : null;
  return Boolean(
    editor?.querySelector(
      ".find-widget.visible, .suggest-widget.visible, .parameter-hints-widget.visible"
    )
  );
}

function menuOpen() {
  return el.contextMenu.style.display !== "none" || el.viewMenu.style.display !== "none";
}

function closeMenus() {
  hideContextMenu();
  window.PanelLayout.closeViewMenu();
}

function settingsOwns(target) {
  return (
    Boolean(window.EditorSettingsPanel?.isOpen()) &&
    target instanceof Element &&
    Boolean(target.closest("#editor-settings-modal"))
  );
}

// Closes the front-most dismissible layer. Returns false when there is
// nothing to close (or a control should handle Esc itself) so the key is left
// alone.
function dismissTopLayer(event) {
  const target = event.target;
  if (!el.quickPicker.hidden) {
    closeQuickPicker();
    return true;
  }
  if (document.body.classList.contains("dragging-view")) return false; // layout drag owns Esc
  if (monacoWidgetOpen(target)) return false;
  if (menuOpen()) {
    closeMenus();
    return true;
  }
  if (window.EditorSettingsPanel?.isOpen()) {
    window.EditorSettingsPanel.close();
    return true;
  }
  const inMonaco = target instanceof Element && target.closest(".monaco-editor");
  if (isTypingTarget(target) && !inMonaco) return false; // e.g. cookie cell edit cancels itself
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (active?.section === "requests" && !el.requestDetail.hidden) {
    closeTab(active.id);
    return true;
  }
  return false;
}

function wrapIndex(current, step, length) {
  if (current === -1) return step > 0 ? 0 : length - 1;
  return (current + step + length) % length;
}

// Selects the request above/below the current one in the order the list shows.
// Stops at either end like DevTools instead of wrapping.
function selectAdjacentRequest(step) {
  const entries = sortRequestEntries(filteredRequestEntries());
  if (!entries.length) return;
  const current =
    state.selectedSection === "requests"
      ? entries.findIndex(([path]) => path === state.selectedPath)
      : -1;
  const next =
    current === -1
      ? step > 0
        ? 0
        : entries.length - 1
      : Math.min(Math.max(current + step, 0), entries.length - 1);
  if (next !== current) openFile(entries[next][0], "requests");
}

function arrowNavigatesRequests(target) {
  if (isTypingTarget(target) || !el.quickPicker.hidden || menuOpen()) return false;
  if (settingsOwns(target)) return false;
  const inList = target instanceof Element && target.closest("#network-panel");
  return state.selectedSection === "requests" || Boolean(inList);
}

// Cycles the tabs of the front-most view: the settings categories, the request
// detail tabs (Headers, Payload, ...), or else the open editor tabs.
function cycleTabs(step, target) {
  if (settingsOwns(target)) {
    const nav = document.getElementById("es-nav");
    const items = [...nav.querySelectorAll(".es-nav-item")];
    if (nav.hidden || !items.length) return;
    const current = items.findIndex((item) => item.classList.contains("active"));
    items[wrapIndex(current, step, items.length)].click();
    return;
  }
  if (state.selectedSection === "requests" && !el.requestDetail.hidden) {
    const buttons = [...el.requestDetailTabs.querySelectorAll("button:not([hidden])")];
    if (buttons.length < 2) return;
    const current = buttons.findIndex((b) => b.dataset.requestTab === state.requestDetailTab);
    state.requestDetailTab = buttons[wrapIndex(current, step, buttons.length)].dataset.requestTab;
    showSelectedRequestTab();
    return;
  }
  const tabs = tabsForWorkspace(state.workspace);
  if (tabs.length < 2) return;
  const current = tabs.findIndex((tab) => tab.id === state.activeTabId);
  const next = tabs[wrapIndex(current, step, tabs.length)];
  state.activeTabId = next.id;
  renderTabs();
  selectFile(next.path, next.section);
}

document.addEventListener(
  "keydown",
  (event) => {
    if (!panelVisible || !document.hasFocus()) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLocaleLowerCase();
    if (event.key === "Escape") {
      if (!modifier && !event.altKey && !event.shiftKey && dismissTopLayer(event)) {
        swallowShortcut(event);
      }
      return;
    }
    // Format the open file: Ctrl+Shift+F (and VS Code's Shift+Alt+F).
    const ctrlShiftF = modifier && event.shiftKey && !event.altKey && key === "f";
    const altShiftF = !modifier && event.shiftKey && event.altKey && key === "f";
    if (ctrlShiftF || altShiftF) {
      swallowShortcut(event);
      formatCurrentFile();
      return;
    }
    if (modifier && event.altKey && !event.shiftKey && key === "b") {
      swallowShortcut(event);
      window.PanelLayout.toggleDock("right");
      return;
    }
    if (
      event.altKey &&
      !modifier &&
      !event.shiftKey &&
      (key === "arrowleft" || key === "arrowright")
    ) {
      // Option+Arrow moves by word in Mac text fields; plain Alt+Arrow is free
      // everywhere else, including inside Monaco.
      const target = event.target;
      const inMonaco = target instanceof Element && target.closest(".monaco-editor");
      const typing = isTypingTarget(target) && !(inMonaco && !IS_MAC);
      if (!typing && el.quickPicker.hidden && !menuOpen()) {
        swallowShortcut(event);
        cycleTabs(key === "arrowright" ? 1 : -1, target);
      }
      return;
    }
    if (event.altKey) return;
    if (!modifier && !event.shiftKey && (key === "arrowup" || key === "arrowdown")) {
      if (arrowNavigatesRequests(event.target)) {
        swallowShortcut(event);
        selectAdjacentRequest(key === "arrowdown" ? 1 : -1);
      }
      return;
    }
    if (modifier && event.shiftKey && key === "h") {
      swallowShortcut(event);
      setWorkspaceSearchOpen(true);
      return;
    }
    if (modifier && event.shiftKey && key === "p") {
      swallowShortcut(event);
      openQuickPicker("commands").catch((error) => setStatus("inactive", error.message));
      return;
    }
    if (modifier && !event.shiftKey && key === "p") {
      swallowShortcut(event);
      openQuickPicker("files").catch((error) => setStatus("inactive", error.message));
      return;
    }
    if (modifier && !event.shiftKey && key === "b") {
      swallowShortcut(event);
      window.PanelLayout.toggleDock("left");
      return;
    }
    if (modifier && !event.shiftKey && key === "j") {
      swallowShortcut(event);
      window.PanelLayout.toggleDock("bottom");
      return;
    }
    if (modifier && !event.shiftKey && event.key === ",") {
      swallowShortcut(event);
      window.EditorSettingsPanel?.toggle();
    }
  },
  true
);

// ── Init ─────────────────────────────────────────────────────────────────────

updateCollectionModeUI();
updateLocationFilterUI();
el.main.dataset.workspace = state.workspace;
for (const btn of el.workspaceTabs.querySelectorAll(".workspace-tab")) {
  const active = btn.dataset.workspace === state.workspace;
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
}
window.PanelLayout?.init();
renderTabs();
