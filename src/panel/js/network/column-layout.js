// Request table columns in the UI: applies the stored layout, reorders a column by dragging its
// header, resizes it by dragging the right edge of its header, and builds the show/hide menu
// opened by right-clicking the table. The layout rules live in lib/network-columns.js. Loaded
// after network-table.js.
"use strict";

// Pushes the layout into the table: grid tracks and minimum width as CSS variables, hidden
// columns as a data attribute the stylesheet matches. Rows are never touched, so a change costs
// the same with ten requests or ten thousand.
function applyNetworkColumns() {
  const layout = prefs.networkColumns;
  networkTableElement.style.setProperty("--network-cols", NetworkColumns.gridTemplate(layout));
  networkTableElement.style.setProperty(
    "--network-min-width",
    `${NetworkColumns.minWidth(layout)}px`
  );
  networkTableElement.dataset.hiddenColumns = layout.hidden.join(" ");
  // Header and cells place themselves with the CSS `order` property, so rows keep their DOM.
  for (const column of NetworkColumns.COLUMNS) {
    networkTableElement.style.setProperty(
      `--network-order-${column.id}`,
      String(NetworkColumns.orderIndex(layout, column.id))
    );
  }
}

function setNetworkColumns(layout, { persist = true } = {}) {
  prefs.networkColumns = layout;
  applyNetworkColumns();
  if (persist) savePref("networkColumns", NetworkColumns.serialize(layout));
}

function toggleNetworkColumn(id) {
  const layout = NetworkColumns.toggle(prefs.networkColumns, id);
  setNetworkColumns(layout);
  // Sorting by a column that is no longer shown would reorder rows for no visible reason.
  if (NetworkColumns.isHidden(layout, id) && state.requestSort.key === id) {
    state.requestSort = { key: null, dir: "asc" };
    renderNetworkTable();
  }
}

// Menu entries for the context menu: one checkable item per hideable column, then a reset.
// The Name column carries the method and URL, so it always stays.
function networkColumnActions() {
  const toggles = NetworkColumns.COLUMNS.filter((column) => column.hideable).map((column) => ({
    id: `ctx-column-${column.id}`,
    label: column.label,
    keepOpen: true,
    isChecked: () => !NetworkColumns.isHidden(prefs.networkColumns, column.id),
    run: () => toggleNetworkColumn(column.id),
  }));
  return [
    ...toggles,
    null,
    {
      id: "ctx-columns-reset",
      label: "Reset columns",
      run: () => setNetworkColumns(NetworkColumns.defaultLayout()),
    },
  ];
}

// -- Resizing --

for (const button of el.networkTableHeader.querySelectorAll(".network-col")) {
  const handle = document.createElement("span");
  handle.className = "network-col-resize";
  handle.setAttribute("aria-hidden", "true");
  handle.title = "Drag to resize, double-click to reset";
  button.append(handle);
}

let networkColumnDrag = null;

function endNetworkColumnDrag() {
  if (!networkColumnDrag) return;
  networkColumnDrag = null;
  el.networkTableHeader.classList.remove("resizing");
  savePref("networkColumns", NetworkColumns.serialize(prefs.networkColumns));
}

// The resize handle sits inside the sortable header button, and the release that ends a column
// move lands on a header too; neither may sort.
let swallowHeaderClick = false;
el.networkTableHeader.addEventListener(
  "click",
  (event) => {
    if (event.target.closest(".network-col-resize")) {
      event.stopPropagation();
    } else if (swallowHeaderClick) {
      swallowHeaderClick = false;
      event.stopPropagation();
    }
  },
  true
);

el.networkTableHeader.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".network-col-resize");
  if (!handle || event.button !== 0) return;
  event.preventDefault();
  const header = handle.parentElement;
  networkColumnDrag = {
    id: header.dataset.sortKey,
    startX: event.clientX,
    startWidth: header.getBoundingClientRect().width,
  };
  handle.setPointerCapture(event.pointerId);
  el.networkTableHeader.classList.add("resizing");
});

el.networkTableHeader.addEventListener("pointermove", (event) => {
  if (!networkColumnDrag) return;
  const { id, startX, startWidth } = networkColumnDrag;
  const layout = NetworkColumns.setWidth(
    prefs.networkColumns,
    id,
    startWidth + event.clientX - startX
  );
  setNetworkColumns(layout, { persist: false });
});

el.networkTableHeader.addEventListener("pointerup", endNetworkColumnDrag);
el.networkTableHeader.addEventListener("pointercancel", endNetworkColumnDrag);
el.networkTableHeader.addEventListener("lostpointercapture", endNetworkColumnDrag);

el.networkTableHeader.addEventListener("dblclick", (event) => {
  const handle = event.target.closest(".network-col-resize");
  if (!handle) return;
  const id = handle.parentElement.dataset.sortKey;
  setNetworkColumns(NetworkColumns.resetWidth(prefs.networkColumns, id));
});

// -- Reordering --
// Dragging a header past a few pixels (so a plain click still sorts) picks the column up. The
// header under the pointer shows where it would land, and releasing moves it there.

const COLUMN_MOVE_THRESHOLD = 6;
let networkColumnMove = null;

// Shown header buttons from left to right as { id, button, rect }.
function shownNetworkHeaders() {
  return [...el.networkTableHeader.querySelectorAll(".network-col")]
    .filter((button) => getComputedStyle(button).display !== "none")
    .map((button) => ({
      id: button.dataset.sortKey,
      button,
      rect: button.getBoundingClientRect(),
    }))
    .sort((a, b) => a.rect.left - b.rect.left);
}

// Where dropping at pointer position `x` would put column `id`: next to which shown column, and
// on which side. Null when that would leave the column where it is.
function columnDropFor(x, id) {
  const shown = shownNetworkHeaders();
  const from = shown.findIndex((header) => header.id === id);
  const found = shown.findIndex((header) => x < header.rect.left + header.rect.width / 2);
  const slot = found === -1 ? shown.length : found;
  if (from === -1 || slot === from || slot === from + 1) return null;
  const target = slot === shown.length ? shown[shown.length - 1] : shown[slot];
  return { targetId: target.id, after: slot === shown.length, button: target.button };
}

function markColumnDrop(drop) {
  for (const button of el.networkTableHeader.querySelectorAll(".network-col")) {
    button.classList.remove("drop-before", "drop-after");
  }
  if (drop) drop.button.classList.add(drop.after ? "drop-after" : "drop-before");
}

el.networkTableHeader.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".network-col-resize")) return;
  const button = event.target.closest(".network-col");
  if (!button) return;
  networkColumnMove = {
    id: button.dataset.sortKey,
    button,
    pointerId: event.pointerId,
    startX: event.clientX,
    dragging: false,
    drop: null,
  };
});

el.networkTableHeader.addEventListener("pointermove", (event) => {
  const move = networkColumnMove;
  if (!move || event.pointerId !== move.pointerId) return;
  if (!move.dragging) {
    if (Math.abs(event.clientX - move.startX) < COLUMN_MOVE_THRESHOLD) return;
    move.dragging = true;
    el.networkTableHeader.setPointerCapture(event.pointerId);
    el.networkTableHeader.classList.add("moving");
    move.button.classList.add("drag-source");
  }
  move.drop = columnDropFor(event.clientX, move.id);
  markColumnDrop(move.drop);
});

function endNetworkColumnMove(event, apply) {
  const move = networkColumnMove;
  if (!move || event.pointerId !== move.pointerId) return;
  networkColumnMove = null;
  if (!move.dragging) return;
  el.networkTableHeader.classList.remove("moving");
  move.button.classList.remove("drag-source");
  markColumnDrop(null);
  // The click that follows this release is not a request to sort.
  swallowHeaderClick = true;
  setTimeout(() => {
    swallowHeaderClick = false;
  }, 0);
  if (apply && move.drop) {
    const layout = NetworkColumns.move(
      prefs.networkColumns,
      move.id,
      move.drop.targetId,
      move.drop.after
    );
    setNetworkColumns(layout);
  }
}

el.networkTableHeader.addEventListener("pointerup", (event) => endNetworkColumnMove(event, true));
el.networkTableHeader.addEventListener("pointercancel", (event) =>
  endNetworkColumnMove(event, false)
);

// -- Menu --
// Rows open their own menu (and stop the default); anything else in the table, the header
// above all, opens the column menu.

networkTableElement.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  state.contextTarget = { type: "columns" };
  showContextMenu(event.clientX, event.clientY, "columns");
});

applyNetworkColumns();
