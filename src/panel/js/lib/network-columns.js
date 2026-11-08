// Network table column layout: which columns are shown, in what order and how wide. No DOM, no
// I/O. Loaded before state.js, which restores the stored layout through normalize().
"use strict";

const NetworkColumns = (() => {
  const MAX_WIDTH = 800;
  // Matches the table's CSS: 10px between columns and 10px of padding on each side.
  const GAP = 10;
  const PADDING = 20;

  // width null: the column takes whatever room the others leave, until the user resizes it.
  const COLUMNS = [
    { id: "name", label: "Name", width: null, min: 120, hideable: false },
    { id: "method", label: "Method", width: 64, min: 48, hideable: true },
    { id: "status", label: "Status", width: 64, min: 52, hideable: true },
    { id: "type", label: "Type", width: 64, min: 44, hideable: true },
    { id: "domain", label: "Domain", width: 160, min: 64, hideable: true },
    { id: "size", label: "Size", width: 68, min: 44, hideable: true },
    { id: "time", label: "Time", width: 76, min: 44, hideable: true },
    { id: "timestamp", label: "Timestamp", width: 92, min: 76, hideable: true },
  ];
  const byId = new Map(COLUMNS.map((column) => [column.id, column]));

  const clamp = (column, width) => Math.min(MAX_WIDTH, Math.max(column.min, Math.round(width)));

  const DEFAULT_ORDER = COLUMNS.map((column) => column.id);

  // A saved order completed to every column: unknown and repeated ids are dropped and columns
  // it does not mention follow in their default order.
  function completeOrder(order) {
    const ids = [];
    for (const id of Array.isArray(order) ? order : []) {
      if (byId.has(id) && !ids.includes(id)) ids.push(id);
    }
    for (const id of DEFAULT_ORDER) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // The order as stored: empty for the default order, so an untouched layout saves nothing.
  function canonicalOrder(order) {
    const full = completeOrder(order);
    return full.every((id, index) => id === DEFAULT_ORDER[index]) ? [] : full;
  }

  function defaultLayout() {
    return { hidden: [], widths: {}, order: [] };
  }

  // A stored layout (JSON text or an object) reduced to what is valid: known columns, columns
  // that may be hidden, and finite widths inside each column's limits. Anything else is dropped.
  function normalize(raw) {
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return defaultLayout();
      }
    }
    if (!value || typeof value !== "object") return defaultLayout();
    const hidden = [];
    if (Array.isArray(value.hidden)) {
      for (const id of value.hidden) {
        if (byId.get(id)?.hideable && !hidden.includes(id)) hidden.push(id);
      }
    }
    const widths = {};
    if (value.widths && typeof value.widths === "object") {
      for (const [id, width] of Object.entries(value.widths)) {
        const column = byId.get(id);
        if (column && typeof width === "number" && Number.isFinite(width)) {
          widths[id] = clamp(column, width);
        }
      }
    }
    return { hidden, widths, order: canonicalOrder(value.order) };
  }

  function serialize(layout) {
    return JSON.stringify({ hidden: layout.hidden, widths: layout.widths, order: layout.order });
  }

  function isHidden(layout, id) {
    return layout.hidden.includes(id);
  }

  // Every column in layout order, shown or not.
  function ordered(layout) {
    return completeOrder(layout.order).map((id) => byId.get(id));
  }

  // The shown columns, left to right.
  function visible(layout) {
    return ordered(layout).filter((column) => !isHidden(layout, column.id));
  }

  // Position of a column in the layout order, for the CSS order of its header and cells.
  function orderIndex(layout, id) {
    return completeOrder(layout.order).indexOf(id);
  }

  // The column's width in pixels, or null while it is fluid.
  function widthOf(layout, id) {
    return layout.widths[id] ?? byId.get(id).width;
  }

  function toggle(layout, id) {
    if (!byId.get(id)?.hideable) return layout;
    const hidden = isHidden(layout, id)
      ? layout.hidden.filter((item) => item !== id)
      : [...layout.hidden, id];
    return { ...layout, hidden };
  }

  function setWidth(layout, id, width) {
    const column = byId.get(id);
    if (!column || !Number.isFinite(width)) return layout;
    return { ...layout, widths: { ...layout.widths, [id]: clamp(column, width) } };
  }

  function resetWidth(layout, id) {
    const { [id]: _removed, ...widths } = layout.widths;
    return { ...layout, widths };
  }

  // `id` moved next to `targetId`: before it, or after it when `after` is set.
  function move(layout, id, targetId, after = false) {
    if (id === targetId || !byId.has(id) || !byId.has(targetId)) return layout;
    const ids = completeOrder(layout.order).filter((item) => item !== id);
    ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, id);
    return { ...layout, order: canonicalOrder(ids) };
  }

  // Grid tracks for the visible columns. With no fluid column left (the name was resized) an
  // empty trailing track soaks up the slack so the fixed columns keep their widths.
  function tracks(layout) {
    const list = visible(layout).map((column) => {
      const width = widthOf(layout, column.id);
      return width === null
        ? { css: `minmax(${column.min}px, 1fr)`, min: column.min }
        : { css: `${width}px`, min: width };
    });
    if (!visible(layout).some((column) => widthOf(layout, column.id) === null)) {
      list.push({ css: "minmax(0, 1fr)", min: 0 });
    }
    return list;
  }

  function gridTemplate(layout) {
    return tracks(layout)
      .map((track) => track.css)
      .join(" ");
  }

  // Narrowest the table can be before it scrolls sideways.
  function minWidth(layout) {
    const list = tracks(layout);
    return list.reduce((sum, track) => sum + track.min, 0) + GAP * (list.length - 1) + PADDING;
  }

  return {
    COLUMNS,
    defaultLayout,
    normalize,
    serialize,
    isHidden,
    visible,
    widthOf,
    toggle,
    setWidth,
    resetWidth,
    gridTemplate,
    minWidth,
    move,
    orderIndex,
  };
})();
