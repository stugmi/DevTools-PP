// Request list selection: the focused path (state.listSelection.network), the Shift-click
// range anchor and the Set of selected paths (state.requestSelection). All three are
// independent of the request detail document (state.selectedPath / selectedSection). The
// Set keeps paths that filters currently hide; only removed entries are pruned. This module
// never touches the DOM: callers repaint with syncNetworkRowSelection().
// Callers pass visible entries in display order, keeping this state owner independent of UI code.
"use strict";

const RequestSelection = (() => {
  function store() {
    return state.requestSelection;
  }

  function exists(path) {
    return typeof path === "string" && Object.hasOwn(state.requestTree, path);
  }

  function focusedPath() {
    return state.listSelection.network;
  }

  function isSelected(path) {
    return store().paths.has(path);
  }

  // Normal click, Enter and arrow keys: exactly this request is selected.
  function selectOnly(path) {
    const selection = store();
    selection.paths.clear();
    selection.paths.add(path);
    selection.anchor = path;
    state.listSelection.network = path;
  }

  // Ctrl/Cmd-click.
  function toggle(path) {
    const selection = store();
    if (!selection.paths.delete(path)) selection.paths.add(path);
    selection.anchor = path;
    state.listSelection.network = path;
  }

  // Shift-click: the visible rows between the anchor and `path` in the order shown. Replaces
  // the selection, or extends it when `additive`. The anchor stays put.
  function selectRange(path, entries, additive = false) {
    const selection = store();
    const ordered = entries.map(([visible]) => visible);
    const to = ordered.indexOf(path);
    if (to === -1) return;
    let from = ordered.indexOf(selection.anchor);
    if (from === -1) from = ordered.indexOf(focusedPath());
    if (from === -1) from = to;
    selection.anchor = ordered[from];
    if (!additive) selection.paths.clear();
    const [start, end] = from <= to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) selection.paths.add(ordered[i]);
    state.listSelection.network = path;
  }

  // The request document of a request opened by other routes (tabs, search, initiator frames):
  // keeps a multi-selection that already contains it, otherwise selects only it.
  function focus(path) {
    if (isSelected(path)) state.listSelection.network = path;
    else selectOnly(path);
  }

  // Drops paths of requests that no longer exist (capture reset, replaced tree).
  function prune() {
    const selection = store();
    for (const path of selection.paths) {
      if (!exists(path)) selection.paths.delete(path);
    }
    if (selection.anchor !== null && !exists(selection.anchor)) selection.anchor = null;
    if (focusedPath() !== null && !exists(focusedPath())) state.listSelection.network = null;
  }

  // Selected requests that the current filters show, as [path, entry] in the order of the
  // list. Hidden selected paths stay stored but are not returned.
  function selectedVisibleEntries(entries) {
    prune();
    const { paths } = store();
    if (!paths.size) return [];
    return entries.filter(([path]) => paths.has(path));
  }

  // [path, entry] pairs a request action applies to: the whole visible selection when the
  // acted-on request is part of it, otherwise just that request. A fresh array each call so
  // callers can hold it across async work.
  function targetsFor(path, entries) {
    if (!exists(path)) return [];
    if (!isSelected(path)) return [[path, state.requestTree[path]]];
    return selectedVisibleEntries(entries);
  }

  return {
    focusedPath,
    isSelected,
    selectOnly,
    toggle,
    selectRange,
    focus,
    prune,
    selectedVisibleEntries,
    targetsFor,
  };
})();
