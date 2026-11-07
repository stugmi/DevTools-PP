// Global keyboard handling: Esc layering, request list arrows, tab cycling and app shortcuts.
// Chords come from core/keybinds.js. Loaded after layout.js, before main.js.

// -- Helpers --

// IS_MAC comes from core/keybinds.js.
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

function swallowShortcut(event) {
  event.preventDefault();
  event.stopPropagation();
}

// True for controls that use the arrow keys and Esc themselves. Read-only inputs
// (the request URL field) don't count.
function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && !target.readOnly && !NON_TEXT_INPUT_TYPES.has(target.type)
  );
}

function monacoEditorOf(target) {
  return target instanceof Element ? target.closest(".monaco-editor") : null;
}

// A Monaco widget (find, suggestions, parameter hints) gets Esc before anything behind it.
function monacoWidgetOpen(target) {
  return Boolean(
    monacoEditorOf(target)?.querySelector(
      ".find-widget.visible, .suggest-widget.visible, .parameter-hints-widget.visible"
    )
  );
}

function menuOpen() {
  return el.contextMenu.style.display !== "none" || el.viewMenu.style.display !== "none";
}

function settingsOwns(target) {
  return (
    Boolean(window.EditorSettingsPanel?.isOpen()) &&
    target instanceof Element &&
    Boolean(target.closest("#editor-settings-modal"))
  );
}

function wrapIndex(current, step, length) {
  if (current === -1) return step > 0 ? 0 : length - 1;
  return (current + step + length) % length;
}

// -- Esc --

// Closes the request view as one unit, like the DevTools detail pane. The preview tab goes
// away and pinned request tabs stay listed but none is promoted, so the next Esc has
// nothing left to close and reaches DevTools. The list keeps its selected row.
function dismissRequestView() {
  state.tabs = state.tabs.filter((tab) => tab.section !== "requests" || tab.pinned);
  state.activeTabId = null;
  state.selectedPath = null;
  state.selectedSection = null;
  renderTabs();
  resetPreview();
}

// Closes the front-most dismissible layer. Returns false when there is nothing to close
// (or a control should handle Esc itself) so the key is left alone.
function dismissTopLayer(event) {
  const target = event.target;
  if (!el.quickPicker.hidden) {
    closeQuickPicker();
    return true;
  }
  if (window.SourceFilterPanel?.isOpen()) {
    window.SourceFilterPanel.close();
    return true;
  }
  if (window.DomainFilterPanel.close()) return true;
  if (document.body.classList.contains("dragging-view")) return false; // layout drag owns Esc
  if (monacoWidgetOpen(target)) return false;
  if (menuOpen()) {
    if (closeContextSubmenu()) return true;
    hideContextMenu();
    window.PanelLayout.closeViewMenu();
    return true;
  }
  if (window.EditorSettingsPanel?.isOpen()) {
    window.EditorSettingsPanel.close();
    return true;
  }
  if (isTypingTarget(target) && !monacoEditorOf(target)) return false; // e.g. cookie cell edit
  if (state.selectedSection === "requests" && !el.requestDetail.hidden) {
    dismissRequestView();
    return true;
  }
  return false;
}

// -- Request list --

// Selects only the request above/below the focused one in the order the list shows, and
// opens it. Stops at either end like DevTools instead of wrapping.
function selectAdjacentRequest(step) {
  const entries = visibleRequestEntries();
  if (!entries.length) return;
  const focused = RequestSelection.focusedPath();
  const current = focused ? entries.findIndex(([path]) => path === focused) : -1;
  const next =
    current === -1
      ? step > 0
        ? 0
        : entries.length - 1
      : Math.min(Math.max(current + step, 0), entries.length - 1);
  if (next !== current) {
    const path = entries[next][0];
    openRequestRow(path);
    networkRows.get(path)?.row.scrollIntoView({ block: "nearest" });
  }
}

function arrowNavigatesRequests(target) {
  if (isTypingTarget(target) || !el.quickPicker.hidden || menuOpen()) return false;
  if (window.DomainFilterPanel.isOpen()) return false;
  if (settingsOwns(target)) return false;
  // The explorer tree, splitters and the hex viewer grid use the arrow keys themselves.
  if (
    target instanceof Element &&
    target.closest("#tree-root, .dock-splitter, .inline-splitter, .hexv")
  ) {
    return false;
  }
  const inList = target instanceof Element && target.closest("#network-panel");
  return state.selectedSection === "requests" || Boolean(inList);
}

// -- Tabs --

// Cycles the tabs of the front-most view: the settings categories, the request detail tabs
// (Headers, Payload, ...), or else the open editor tabs.
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
    const current = buttons.findIndex((b) => b.dataset.requestTab === currentRequestTab());
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

function cycleTabsFromKey(event, step) {
  const target = event.target;
  // Option+Arrow moves by word in Mac text fields. Plain Alt+Arrow is free everywhere
  // else, including inside Monaco.
  const typing = isTypingTarget(target) && !(monacoEditorOf(target) && !IS_MAC);
  if (typing || !el.quickPicker.hidden || menuOpen()) return false;
  cycleTabs(step, target);
}

function selectAdjacentRequestFromKey(event, step) {
  if (!arrowNavigatesRequests(event.target)) return false;
  selectAdjacentRequest(step);
}

function openQuickPickerFromKey(mode) {
  openQuickPicker(mode);
}

// -- Dispatch --

// Keybind id -> action. An action returns false when it declined the key, which then
// reaches the page or DevTools. Anything else swallows it.
const KEY_ACTIONS = [
  ["overlay.dismiss", (event) => dismissTopLayer(event)],
  ["file.format", () => formatCurrentFile()],
  ["palette.files", () => openQuickPickerFromKey("files")],
  ["palette.commands", () => openQuickPickerFromKey("commands")],
  ["search.workspace", () => setWorkspaceSearchOpen(true)],
  ["settings.toggle", () => window.EditorSettingsPanel?.toggle()],
  ["view.toggleLeft", () => window.PanelLayout.toggleDock("left")],
  ["view.toggleBottom", () => window.PanelLayout.toggleDock("bottom")],
  ["view.toggleRight", () => window.PanelLayout.toggleDock("right")],
  ["tabs.previous", (event) => cycleTabsFromKey(event, -1)],
  ["tabs.next", (event) => cycleTabsFromKey(event, 1)],
  ["requests.previous", (event) => selectAdjacentRequestFromKey(event, -1)],
  ["requests.next", (event) => selectAdjacentRequestFromKey(event, 1)],
];

document.addEventListener(
  "keydown",
  (event) => {
    if (!state.panelVisible || !document.hasFocus()) return;
    for (const [id, action] of KEY_ACTIONS) {
      if (!Keybinds.matches(event, id)) continue;
      if (action(event) !== false) swallowShortcut(event);
      return;
    }
  },
  true
);
