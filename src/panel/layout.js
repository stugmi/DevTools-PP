"use strict";

// VS Code-style dock layout. Three movable "views" (Explorer, Requests,
// Search) can live in any of three docks (left, right, bottom) around the
// editor in the centre. Docks are resizable (drag the splitter, double-click
// to reset), views can be moved by dragging their header / dock tab /
// activity-bar icon onto a screen edge or via the "⋯" menu, and any dock can
// be hidden. Everything is persisted to localStorage.
window.PanelLayout = (() => {
  const STORAGE_KEY = "se.layout.v1";
  const DOCKS = ["left", "right", "bottom"];
  const DOCK_LABELS = { left: "Left Side Bar", right: "Right Side Bar", bottom: "Bottom Panel" };
  const MIN_SIDE = 160;
  const MIN_BOTTOM = 90;
  const MIN_CENTER_WIDTH = 300;
  const MIN_CENTER_HEIGHT = 140;

  const VIEWS = {
    explorer: {
      title: "Explorer",
      workspaces: ["files"],
      dock: "left",
      visible: true,
      size: { side: 280, bottom: 240 },
    },
    requests: {
      title: "Requests",
      workspaces: ["network"],
      dock: "left",
      visible: true,
      size: { side: 560, bottom: 280 },
    },
    search: {
      title: "Search",
      workspaces: ["files", "network"],
      dock: "left",
      visible: false,
      size: { side: 340, bottom: 260 },
    },
  };
  const VIEW_IDS = Object.keys(VIEWS);

  const viewEls = {};
  const dockEls = {};
  const splitterEls = {};
  const tabsEls = {};
  const emptyEls = {};
  let layout = null;

  // ── State ───────────────────────────────────────────────────────────────

  function defaultLayout() {
    const out = {
      views: {},
      active: { left: "explorer", right: null, bottom: null },
      collapsed: { left: false, right: false, bottom: false },
      emptyOpen: { left: false, right: false, bottom: false },
    };
    for (const id of VIEW_IDS) {
      out.views[id] = {
        dock: VIEWS[id].dock,
        visible: VIEWS[id].visible,
        size: { ...VIEWS[id].size },
      };
    }
    return out;
  }

  function loadLayout() {
    const base = defaultLayout();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return base;
      for (const id of VIEW_IDS) {
        const v = saved.views?.[id];
        if (!v) continue;
        if (DOCKS.includes(v.dock)) base.views[id].dock = v.dock;
        if (typeof v.visible === "boolean") base.views[id].visible = v.visible;
        for (const key of ["side", "bottom"]) {
          const n = Number(v.size?.[key]);
          if (Number.isFinite(n) && n > 0) base.views[id].size[key] = n;
        }
      }
      for (const dock of DOCKS) {
        if (VIEW_IDS.includes(saved.active?.[dock])) base.active[dock] = saved.active[dock];
        else if (saved.active) base.active[dock] = null;
        if (typeof saved.collapsed?.[dock] === "boolean") {
          base.collapsed[dock] = saved.collapsed[dock];
        }
        if (typeof saved.emptyOpen?.[dock] === "boolean") {
          base.emptyOpen[dock] = saved.emptyOpen[dock];
        }
      }
    } catch {
      return base;
    }
    return base;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore storage failures
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  function inWorkspace(id) {
    return VIEWS[id].workspaces.includes(state.workspace);
  }

  function dockViewIds(dock) {
    return VIEW_IDS.filter(
      (id) => layout.views[id].dock === dock && layout.views[id].visible && inWorkspace(id)
    );
  }

  function activeIn(dock) {
    const ids = dockViewIds(dock);
    if (layout.active[dock] && ids.includes(layout.active[dock])) return layout.active[dock];
    return ids[0] || null;
  }

  function dockShown(dock) {
    if (layout.collapsed[dock]) return false;
    return Boolean(activeIn(dock)) || layout.emptyOpen[dock];
  }

  function sizeKey(dock) {
    return dock === "bottom" ? "bottom" : "side";
  }

  function dockSize(dock) {
    const id = activeIn(dock);
    const key = sizeKey(dock);
    if (id) return layout.views[id].size[key];
    return key === "bottom" ? 220 : 260;
  }

  function isViewShown(id) {
    const v = layout.views[id];
    return v.visible && inWorkspace(id) && dockShown(v.dock) && activeIn(v.dock) === id;
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function clampSize(dock, value) {
    const main = el.main;
    if (dock === "bottom") {
      const center = document.getElementById("center");
      const total = center ? center.clientHeight + dockEls.bottom.offsetHeight : main.clientHeight;
      return Math.round(Math.max(MIN_BOTTOM, Math.min(value, total - MIN_CENTER_HEIGHT)));
    }
    const other = dock === "left" ? "right" : "left";
    const otherWidth = dockShown(other) ? dockEls[other].offsetWidth : 0;
    const activity = document.getElementById("activity-bar")?.offsetWidth || 0;
    const max = main.clientWidth - activity - otherWidth - MIN_CENTER_WIDTH;
    return Math.round(Math.max(MIN_SIDE, Math.min(value, Math.max(MIN_SIDE, max))));
  }

  function applyDockSize(dock) {
    const px = `${dockSize(dock)}px`;
    const dockEl = dockEls[dock];
    if (dock === "bottom") {
      dockEl.style.height = px;
      dockEl.style.flexBasis = px;
      dockEl.style.width = "";
    } else {
      dockEl.style.width = px;
      dockEl.style.flexBasis = px;
      dockEl.style.height = "";
    }
  }

  function renderTabs(dock, ids, active) {
    const strip = tabsEls[dock];
    strip.replaceChildren();
    strip.hidden = ids.length < 2;
    if (ids.length < 2) return;
    for (const id of ids) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "dock-tab";
      tab.classList.toggle("active", id === active);
      tab.textContent = VIEWS[id].title;
      tab.dataset.view = id;
      tab.title = `${VIEWS[id].title} — drag to move to another area`;
      attachDragAndMenu(tab, id, () => activateView(id));
      strip.appendChild(tab);
    }
    strip.appendChild(makeMenuButton(active));
  }

  function render() {
    for (const dock of DOCKS) {
      const dockEl = dockEls[dock];
      for (const id of VIEW_IDS) {
        if (layout.views[id].dock === dock && viewEls[id].parentElement !== dockEl) {
          dockEl.appendChild(viewEls[id]);
        }
      }
      const ids = dockViewIds(dock);
      const active = activeIn(dock);
      const shown = dockShown(dock);
      renderTabs(dock, ids, active);
      dockEl.classList.toggle("has-tabs", ids.length > 1);
      for (const id of VIEW_IDS) {
        if (layout.views[id].dock === dock) viewEls[id].hidden = !(shown && id === active);
      }
      emptyEls[dock].hidden = !(shown && !active);
      dockEl.hidden = !shown;
      splitterEls[dock].hidden = !shown;
      if (shown) applyDockSize(dock);
    }

    for (const button of document.querySelectorAll(".activity-btn[data-view]")) {
      const id = button.dataset.view;
      button.hidden = !inWorkspace(id);
      const on = isViewShown(id);
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    const toggles = {
      left: el.btnToggleLeft,
      bottom: el.btnToggleBottom,
      right: el.btnToggleRight,
    };
    for (const dock of DOCKS) {
      const on = dockShown(dock);
      toggles[dock]?.classList.toggle("active", on);
      toggles[dock]?.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function commit() {
    render();
    save();
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  function activateView(id) {
    const v = layout.views[id];
    v.visible = true;
    layout.collapsed[v.dock] = false;
    layout.active[v.dock] = id;
    commit();
  }

  // Show a view and make it the active one in its dock.
  function showView(id) {
    if (!VIEWS[id]) return;
    activateView(id);
  }

  function hideView(id) {
    layout.views[id].visible = false;
    commit();
  }

  // Activity-bar behaviour: clicking the view that's already showing hides the
  // whole dock (like VS Code's side bar), otherwise it reveals the view.
  function toggleView(id) {
    const v = layout.views[id];
    if (isViewShown(id)) {
      layout.collapsed[v.dock] = true;
      commit();
    } else {
      activateView(id);
    }
  }

  function toggleDock(dock) {
    if (dockShown(dock)) {
      layout.collapsed[dock] = true;
      layout.emptyOpen[dock] = false;
    } else {
      layout.collapsed[dock] = false;
      const candidates = VIEW_IDS.filter((id) => layout.views[id].dock === dock && inWorkspace(id));
      if (candidates.length) {
        layout.views[candidates[0]].visible = true;
        layout.active[dock] = candidates[0];
      } else {
        layout.emptyOpen[dock] = true;
      }
    }
    commit();
  }

  function moveView(id, dock) {
    if (!VIEWS[id] || !DOCKS.includes(dock)) return;
    const from = layout.views[id].dock;
    layout.views[id].dock = dock;
    layout.views[id].visible = true;
    layout.collapsed[dock] = false;
    layout.emptyOpen[dock] = false;
    layout.active[dock] = id;
    if (layout.active[from] === id) layout.active[from] = null;
    commit();
  }

  function resetLayout() {
    layout = defaultLayout();
    commit();
  }

  // ── Splitters ───────────────────────────────────────────────────────────

  function initSplitter(dock) {
    const splitter = splitterEls[dock];
    const dockEl = dockEls[dock];

    function setSize(px) {
      const id = activeIn(dock);
      const next = clampSize(dock, px);
      if (id) layout.views[id].size[sizeKey(dock)] = next;
      dockEl.style[dock === "bottom" ? "height" : "width"] = `${next}px`;
      dockEl.style.flexBasis = `${next}px`;
    }

    splitter.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add("dragging");
      document.body.classList.add(dock === "bottom" ? "resizing-row" : "resizing-col");
      const startX = event.clientX;
      const startY = event.clientY;
      const startSize = dock === "bottom" ? dockEl.offsetHeight : dockEl.offsetWidth;

      function onMove(moveEvent) {
        if (dock === "left") setSize(startSize + (moveEvent.clientX - startX));
        else if (dock === "right") setSize(startSize - (moveEvent.clientX - startX));
        else setSize(startSize - (moveEvent.clientY - startY));
      }
      function onUp() {
        splitter.removeEventListener("pointermove", onMove);
        splitter.removeEventListener("pointerup", onUp);
        splitter.removeEventListener("pointercancel", onUp);
        splitter.classList.remove("dragging");
        document.body.classList.remove("resizing-row", "resizing-col");
        save();
      }
      splitter.addEventListener("pointermove", onMove);
      splitter.addEventListener("pointerup", onUp);
      splitter.addEventListener("pointercancel", onUp);
    });

    splitter.addEventListener("dblclick", () => {
      const id = activeIn(dock);
      if (!id) return;
      layout.views[id].size[sizeKey(dock)] = VIEWS[id].size[sizeKey(dock)];
      commit();
    });
  }

  // ── Drag & drop of views between docks ──────────────────────────────────

  function zoneAt(x, y) {
    const rect = el.main.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    if (fy > 0.72) return "bottom";
    if (fx < 0.25) return "left";
    if (fx > 0.75) return "right";
    return null;
  }

  function beginViewDrag(id, startEvent) {
    const overlay = document.getElementById("dock-drop-overlay");
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    let dragging = false;

    function highlight(zone) {
      for (const z of overlay.querySelectorAll(".drop-zone")) {
        z.classList.toggle("active", z.dataset.dock === zone);
      }
    }

    function onMove(event) {
      if (!dragging) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < 6) return;
        dragging = true;
        overlay.hidden = false;
        document.body.classList.add("dragging-view");
      }
      highlight(zoneAt(event.clientX, event.clientY));
    }

    function finish(event) {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.hidden = true;
      document.body.classList.remove("dragging-view");
      highlight(null);
      if (!dragging) return;
      // The pointerup that ends a drag must not also count as a click.
      const swallow = (clickEvent) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallow, true), 0);
      const target = event.type === "pointerup" ? zoneAt(event.clientX, event.clientY) : null;
      if (target) moveView(id, target);
    }

    function onKey(event) {
      if (event.key === "Escape") finish({ type: "cancel" });
    }

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    document.addEventListener("keydown", onKey, true);
  }

  // Makes `target` draggable (moves view `id` between docks) and gives it the
  // view context menu. A plain click calls `onClick`.
  function attachDragAndMenu(target, id, onClick) {
    target.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".view-header-actions")) return;
      beginViewDrag(id, event);
    });
    if (onClick) target.addEventListener("click", onClick);
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openViewMenu(id, event.clientX, event.clientY);
    });
  }

  // ── View menu ───────────────────────────────────────────────────────────

  function closeViewMenu() {
    el.viewMenu.style.display = "none";
    el.viewMenu.replaceChildren();
  }

  function viewMenuItems(id) {
    const current = layout.views[id].dock;
    const items = DOCKS.map((dock) => ({
      label: `Move to ${DOCK_LABELS[dock]}`,
      checked: dock === current,
      run: () => moveView(id, dock),
    }));
    items.push({ separator: true });
    items.push({ label: `Hide ${VIEWS[id].title}`, run: () => hideView(id) });
    items.push({ label: "Reset Layout", run: resetLayout });
    return items;
  }

  function openViewMenu(id, x, y) {
    const menu = el.viewMenu;
    menu.replaceChildren();
    for (const item of viewMenuItems(id)) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "ctx-separator";
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "ctx-item";
      row.setAttribute("role", "menuitem");
      row.classList.toggle("checked", Boolean(item.checked));
      row.textContent = item.label;
      row.addEventListener("click", () => {
        closeViewMenu();
        item.run();
      });
      menu.appendChild(row);
    }
    menu.style.display = "block";
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
  }

  // ── Palette commands ────────────────────────────────────────────────────

  function commands() {
    const out = [
      { label: "View: Reset Layout", detail: "", run: resetLayout },
      { label: "View: Toggle Left Side Bar", detail: "Ctrl+B", run: () => toggleDock("left") },
      { label: "View: Toggle Bottom Panel", detail: "Ctrl+J", run: () => toggleDock("bottom") },
      {
        label: "View: Toggle Right Side Bar",
        detail: "Ctrl+Alt+B",
        run: () => toggleDock("right"),
      },
    ];
    for (const id of VIEW_IDS) {
      out.push({ label: `View: Show ${VIEWS[id].title}`, detail: "", run: () => showView(id) });
      for (const dock of DOCKS) {
        out.push({
          label: `View: Move ${VIEWS[id].title} to ${DOCK_LABELS[dock]}`,
          detail: "",
          run: () => moveView(id, dock),
        });
      }
    }
    return out;
  }

  // ── Workspace + init ────────────────────────────────────────────────────

  function moveFilterInput(ws) {
    const target = document.getElementById(
      ws === "network" ? "network-filter-input-slot" : "files-filter-input-slot"
    );
    if (target && el.filterInput.parentElement !== target) {
      target.appendChild(el.filterInput);
    }
  }

  // Called (via switchWorkspace) whenever the Files/Network workspace changes.
  function applyWorkspace(ws) {
    document.getElementById("app").dataset.workspace = ws;
    el.main.dataset.workspace = ws;
    moveFilterInput(ws);
    if (layout) render();
  }

  function makeMenuButton(id) {
    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "btn btn-icon btn-ghost view-menu-btn";
    menuButton.title = "Move or hide this view";
    menuButton.setAttribute("aria-label", `${VIEWS[id].title} view options`);
    menuButton.textContent = "⋯";
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = menuButton.getBoundingClientRect();
      openViewMenu(id, rect.left, rect.bottom + 2);
    });
    return menuButton;
  }

  function decorateView(id) {
    const viewEl = viewEls[id];
    const header = viewEl.querySelector(".view-header");
    if (!header) return;
    let actions = header.querySelector(".view-header-actions");
    if (!actions) {
      actions = document.createElement("span");
      actions.className = "view-header-actions";
      header.appendChild(actions);
    }
    actions.appendChild(makeMenuButton(id));
    header.title = "Drag to move this view to another area";
    attachDragAndMenu(header, id);
  }

  function init() {
    for (const id of VIEW_IDS) viewEls[id] = document.querySelector(`.view[data-view="${id}"]`);
    for (const dock of DOCKS) {
      dockEls[dock] = document.getElementById(`dock-${dock}`);
      splitterEls[dock] = document.querySelector(`.dock-splitter[data-dock="${dock}"]`);
      const tabs = document.createElement("div");
      tabs.className = "dock-tabs";
      tabs.hidden = true;
      dockEls[dock].prepend(tabs);
      tabsEls[dock] = tabs;
      const empty = document.createElement("div");
      empty.className = "dock-empty";
      empty.textContent = "Drag a view here, or use a view’s ⋯ menu → Move";
      empty.hidden = true;
      dockEls[dock].appendChild(empty);
      emptyEls[dock] = empty;
      initSplitter(dock);
    }
    layout = loadLayout();
    for (const id of VIEW_IDS) decorateView(id);

    for (const button of document.querySelectorAll(".activity-btn[data-view]")) {
      attachDragAndMenu(button, button.dataset.view, () => toggleView(button.dataset.view));
    }
    el.btnToggleLeft.addEventListener("click", () => toggleDock("left"));
    el.btnToggleBottom.addEventListener("click", () => toggleDock("bottom"));
    el.btnToggleRight.addEventListener("click", () => toggleDock("right"));
    document.addEventListener("click", closeViewMenu);
    window.addEventListener("blur", closeViewMenu);
    window.addEventListener("resize", () => {
      for (const dock of DOCKS) if (dockShown(dock)) applyDockSize(dock);
    });

    applyWorkspace(state.workspace);
    render();
  }

  return {
    init,
    applyWorkspace,
    showView,
    hideView,
    toggleView,
    toggleDock,
    moveView,
    resetLayout,
    isViewShown,
    commands,
    closeViewMenu,
  };
})();
