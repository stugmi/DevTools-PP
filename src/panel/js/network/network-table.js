// Network table: request filters, sorting and row rendering.
// Loaded after capture.js (uses requestTypeFor) and before request-detail.js.

"use strict";

// -- Cached per-entry facts --
// Derived once per entry (entries are never mutated in a way that changes them).

// Maps unknown, negative (HAR -1) and non-numeric values to null.
function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function requestHost(entry) {
  if (entry._reqHost === undefined) {
    try {
      // data: and about: URLs parse but have an empty host; "" would mean "all domains".
      entry._reqHost =
        new URL(entry?._record?.request?.url || entry?.sourceURL || "").hostname || "(no domain)";
    } catch {
      entry._reqHost = "(no domain)";
    }
  }
  return entry._reqHost;
}

function requestKind(entry) {
  return (entry._kind ??= requestTypeFor(entry));
}

function requestRowUrlPath(entry) {
  if (entry._pathLabel === undefined) {
    const url = entry._record.request.url;
    try {
      const parsed = new URL(url);
      entry._pathLabel = parsed.pathname + parsed.search;
    } catch {
      entry._pathLabel = url;
    }
  }
  return entry._pathLabel;
}

function requestSearchText(path, entry) {
  if (entry._searchText === undefined) {
    const { request, response } = entry._record;
    entry._searchText =
      `${path}\n${request.method}\n${request.url}\n${response.status ?? ""}\n${requestStatusView(entry._record).text}\n${response.failure?.error ?? ""}\n${requestKind(entry)}`.toLowerCase();
  }
  return entry._searchText;
}

// -- Filtering --

function requestMatchesFilters(path, entry) {
  const record = entry._record;
  if (!record) return false;
  const { domain, type, method, minDuration, maxDuration, hideBlocked } = state.requestFilters;

  if (domain && requestHost(entry) !== domain) return false;
  if (hideBlocked && requestIsBlocked(entry)) return false;
  if (type && !requestMatchesTypeFilter(entry, requestKind(entry), type)) return false;
  if (method && record.request.method.toUpperCase() !== method) return false;
  if (minDuration !== "" || maxDuration !== "") {
    const duration = finiteOrNull(record.durationMs);
    if (duration === null) return false;
    if (minDuration !== "" && duration < Number(minDuration)) return false;
    if (maxDuration !== "" && duration > Number(maxDuration)) return false;
  }
  if (
    state.filterText &&
    !requestSearchText(path, entry).includes(state.filterText.toLowerCase())
  ) {
    return false;
  }
  return true;
}

// The filtered list is recomputed only when the captured set or a filter changed.
let requestListCache = { tree: null, key: "", entries: [] };

function requestListKey() {
  const f = state.requestFilters;
  return [
    state.requestCaptureSequence,
    f.domain,
    f.type,
    f.method,
    f.minDuration,
    f.maxDuration,
    f.hideBlocked,
    state.filterText,
  ].join("\u0001");
}

// Newest-first [path, entry] pairs that pass every filter.
function filteredRequestEntries() {
  const key = requestListKey();
  const cache = requestListCache;
  if (cache.tree === state.requestTree && cache.key === key) {
    return cache.entries;
  }
  const entries = Object.entries(state.requestTree)
    .filter(([path, entry]) => requestMatchesFilters(path, entry))
    .sort(([, a], [, b]) => b._captureSequence - a._captureSequence);
  requestListCache = { tree: state.requestTree, key, entries };
  return entries;
}

// -- Filter options --

let filterOptionsSource = { tree: null, sequence: -1 };
let filterOptionsKey = "";

function setFilterOptions(select, allLabel, values, current) {
  select.replaceChildren(new Option(allLabel, ""));
  for (const value of values) select.add(new Option(value, value));
  // A selection that no longer exists stays visible so the UI matches the active filter.
  if (current && !values.includes(current)) select.add(new Option(current, current));
  select.value = current;
}

// Domains are not a <select>: the Domains popover (domain-filter.js) reads requestDomainOptions().
let requestDomainCounts = new Map();

// [{ host, count }] sorted by host, over every captured request regardless of the filters.
function requestDomainOptions() {
  return [...requestDomainCounts.keys()]
    .sort()
    .map((host) => ({ host, count: requestDomainCounts.get(host) }));
}

// Recounts hosts whenever the capture changes; rebuilds the method options only when a
// method appeared or vanished.
function syncRequestFilterOptions() {
  if (
    filterOptionsSource.tree === state.requestTree &&
    filterOptionsSource.sequence === state.requestCaptureSequence
  ) {
    return;
  }
  filterOptionsSource = { tree: state.requestTree, sequence: state.requestCaptureSequence };

  const hosts = new Map();
  const methods = new Set();
  for (const entry of Object.values(state.requestTree)) {
    const host = requestHost(entry);
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    const method = entry._record?.request?.method?.toUpperCase();
    if (method) methods.add(method);
  }
  requestDomainCounts = hosts;
  const methodList = [...methods].sort();
  const key = methodList.join("\u0001");
  if (key === filterOptionsKey) return;
  filterOptionsKey = key;

  setFilterOptions(el.requestMethodFilter, "All methods", methodList, state.requestFilters.method);
}

function formatTimestamp(capturedAt) {
  const ms = Date.parse(capturedAt);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// -- Sorting --
// Accessors return null for missing values; those always sort last.

const NETWORK_SORT_ACCESSORS = {
  name: ([, entry]) => requestRowUrlPath(entry).toLowerCase(),
  method: ([, entry]) => entry._record.request.method.toUpperCase(),
  status: ([, entry]) => finiteOrNull(entry._record.response.status),
  type: ([, entry]) => requestKind(entry),
  domain: ([, entry]) => requestHost(entry),
  size: ([, entry]) => finiteOrNull(entry._record.response.bodySize),
  time: ([, entry]) => finiteOrNull(entry._record.durationMs),
  timestamp: ([, entry]) => {
    const ms = Date.parse(entry._record.capturedAt);
    return Number.isNaN(ms) ? null : ms;
  },
};

let requestSortCache = { entries: null, key: null, dir: null, sorted: null };

function sortRequestEntries(entries) {
  const { key, dir } = state.requestSort;
  if (!key) return entries;
  const cache = requestSortCache;
  if (cache.entries === entries && cache.key === key && cache.dir === dir) return cache.sorted;

  const accessor = NETWORK_SORT_ACCESSORS[key];
  const sign = dir === "desc" ? -1 : 1;
  const sorted = entries.map((item) => [accessor(item), item]);
  sorted.sort(([av], [bv]) => {
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av < bv) return -sign;
    if (av > bv) return sign;
    return 0;
  });
  const result = sorted.map(([, item]) => item);
  requestSortCache = { entries, key, dir, sorted: result };
  return result;
}

// [path, entry] pairs in the order the table shows them (filters, then sort). Shared by
// selection ranges and batch actions; callers must not mutate the result.
function visibleRequestEntries() {
  return sortRequestEntries(filteredRequestEntries());
}

// -- Rows --

// Status cell colors by requestStatusView kind; pending shows no color.
function statusClassFor(kind) {
  if (kind === "blocked" || kind === "failed" || kind === "error") return "error";
  return kind === "redirect" || kind === "ok" ? kind : "";
}

function networkCell(className, text) {
  const cell = document.createElement("span");
  cell.className = className;
  cell.setAttribute("role", "cell");
  cell.textContent = text;
  return cell;
}

function buildNetworkRow(path, entry) {
  const record = entry._record;
  const row = document.createElement("div");
  row.className = "network-row network-row-grid";
  row.setAttribute("role", "row");
  row.tabIndex = -1;
  row.setAttribute("aria-selected", "false");
  row.dataset.path = path;
  row.dataset.type = "request";
  row.dataset.section = "requests";
  row.title = record.request.url;

  const nameCell = networkCell("network-cell-name", "");
  const urlEl = document.createElement("span");
  urlEl.className = "network-cell-url";
  urlEl.textContent = requestRowUrlPath(entry);
  nameCell.append(urlEl);
  const methodCell = networkCell("network-cell-method", record.request.method);

  const view = requestStatusView(record);
  const statusCell = networkCell("network-cell-status", view.text);
  const statusClass = statusClassFor(view.kind);
  if (statusClass) statusCell.classList.add(statusClass);
  if (view.failed) {
    // Failed or blocked: the whole row is red; the reason is a tooltip and the cell's name.
    row.classList.add("failed");
    statusCell.title = view.title;
    statusCell.setAttribute("aria-label", `${view.text}: ${view.title}`);
  }

  const kind = requestKind(entry);
  const typeCell = networkCell("network-cell-type", kind);
  typeCell.dataset.type = kind;

  const size = finiteOrNull(record.response.bodySize);
  const duration = finiteOrNull(record.durationMs);

  row.append(
    nameCell,
    methodCell,
    statusCell,
    typeCell,
    networkCell("network-cell-domain", requestHost(entry)),
    networkCell("network-cell-size", size === null ? "—" : formatBytes(size)),
    networkCell("network-cell-time", duration === null ? "—" : `${duration.toFixed(0)} ms`),
    networkCell("network-cell-timestamp", formatTimestamp(record.capturedAt))
  );
  return row;
}

// path -> { row, entry }. Rows survive filter, sort and capture renders; a replaced entry
// gets a new row and a new request tree (capture reset) drops the cache.
let networkRows = new Map();
let networkRowsTree = null;
let networkEmptyState = null;
let networkRovingRow = null;
// Rows currently painted as selected, so a repaint only touches what changed.
let networkMarkedRows = new Set();
let renderedSortMark = "";
// Scroll-to-selection triggers: the view of the list (filters + sort) and its visibility.
// The capture sequence is left out so new requests never move the user's scroll position.
let renderedViewKey = "";
let networkWasVisible = false;

// Rows are selectable and several can be selected at once.
const networkTableElement = el.networkTableBody.closest("#network-table");
networkTableElement?.setAttribute("role", "grid");
networkTableElement?.setAttribute("aria-multiselectable", "true");

function networkRowFor(path, entry) {
  const cached = networkRows.get(path);
  if (cached?.entry === entry) return cached.row;
  const row = buildNetworkRow(path, entry);
  networkRows.set(path, { row, entry });
  return row;
}

function setNetworkRovingRow(row) {
  if (networkRovingRow && networkRovingRow !== row) networkRovingRow.tabIndex = -1;
  networkRovingRow = row;
  if (row) row.tabIndex = 0;
}

// Paints the selected rows (class + aria-selected) from state.requestSelection and keeps one
// row in the tab order: the focused request, else the previous roving row, else the first
// selected row, else the first row. Returns the row to scroll to (the focused row when it is
// selected, otherwise the first selected visible row), or null.
function syncNetworkRowSelection() {
  const body = el.networkTableBody;
  const wanted = new Set();
  for (const path of state.requestSelection.paths) {
    const row = networkRows.get(path)?.row;
    if (row?.isConnected) wanted.add(row);
  }
  for (const row of networkMarkedRows) {
    if (wanted.has(row)) continue;
    row.classList.remove("selected");
    row.setAttribute("aria-selected", "false");
  }
  for (const row of wanted) {
    if (networkMarkedRows.has(row)) continue;
    row.classList.add("selected");
    row.setAttribute("aria-selected", "true");
  }
  networkMarkedRows = wanted;

  const focusedPath = state.listSelection.network;
  const focusedRow = focusedPath ? networkRows.get(focusedPath)?.row : null;
  const focused = focusedRow?.isConnected ? focusedRow : null;
  const roving = networkRovingRow?.isConnected ? networkRovingRow : null;
  const firstSelected = wanted.values().next().value || null;
  setNetworkRovingRow(focused || roving || firstSelected || body.querySelector(".network-row"));
  return focused && wanted.has(focused) ? focused : firstSelected;
}

function networkViewKey() {
  const f = state.requestFilters;
  const sort = state.requestSort;
  return [
    f.domain,
    f.type,
    f.method,
    f.minDuration,
    f.maxDuration,
    f.hideBlocked,
    state.filterText,
    sort.key,
    sort.dir,
  ].join("\u0001");
}

function renderNetworkEmptyState(entriesExist) {
  if (!networkEmptyState) {
    networkEmptyState = document.createElement("div");
    networkEmptyState.id = "network-empty-state";
  }
  networkEmptyState.textContent = entriesExist
    ? "No requests match the current filters"
    : "No requests captured yet";
  el.networkTableBody.replaceChildren(networkEmptyState);
}

// Brings the body rows in line with `entries`, creating only rows that are new.
function reconcileNetworkRows(entries) {
  const body = el.networkTableBody;
  const rows = entries.map(([path, entry]) => networkRowFor(path, entry));
  const wanted = new Set(rows);
  let cursor = body.firstChild;
  for (const row of rows) {
    while (cursor && !wanted.has(cursor)) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    if (row === cursor) cursor = cursor.nextSibling;
    else body.insertBefore(row, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

function renderNetworkTable() {
  // Hidden paths stay selected, but removed requests (capture reset) must not linger.
  RequestSelection.prune();
  // The table is brought up to date by switchWorkspace when it becomes visible.
  if (state.workspace !== "network") {
    networkWasVisible = false;
    return;
  }
  const becameVisible = !networkWasVisible;
  networkWasVisible = true;
  const viewKey = networkViewKey();
  const scrollToSelection = becameVisible || viewKey !== renderedViewKey;
  renderedViewKey = viewKey;
  syncRequestFilterOptions();

  const { key, dir } = state.requestSort;
  const sortMark = `${key}\u0001${dir}`;
  if (sortMark !== renderedSortMark) {
    renderedSortMark = sortMark;
    for (const col of el.networkTableHeader.querySelectorAll(".network-col")) {
      const sorted = col.dataset.sortKey === key;
      col.classList.toggle("sorted", sorted);
      col.classList.toggle("sort-asc", sorted && dir === "asc");
    }
  }

  if (networkRowsTree !== state.requestTree) {
    networkRows = new Map();
    networkMarkedRows = new Set();
    networkRowsTree = state.requestTree;
  }

  const entries = visibleRequestEntries();
  el.networkCount.textContent = String(entries.length);
  el.networkExport.disabled = entries.length === 0;

  if (entries.length === 0) {
    renderNetworkEmptyState(Object.keys(state.requestTree).length > 0);
    return;
  }
  reconcileNetworkRows(entries);
  const selectedRow = syncNetworkRowSelection();
  if (scrollToSelection) selectedRow?.scrollIntoView({ block: "nearest" });
}

// Narrow refresh for request filter changes: the table plus the filtered request count in
// the status bar, without rebuilding the explorer tree.
function refreshNetwork() {
  renderNetworkTable();
  updateCaptureStatus();
}

// -- Row events --
// One delegated set of listeners serves every row.

function networkRowOf(event) {
  const row = event.target instanceof Element ? event.target.closest(".network-row") : null;
  return row && el.networkTableBody.contains(row) ? row : null;
}

// Ctrl-click on Windows/Linux, Cmd-click on macOS (where Ctrl-click opens the context menu).
function togglesSelection(event) {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

// Selects only `path`, repaints and shows its detail. Used by click, Enter and the arrow keys.
function openRequestRow(path) {
  RequestSelection.selectOnly(path);
  syncNetworkRowSelection();
  openFile(path, "requests");
}

// Shift-click would otherwise start a text selection across the rows.
el.networkTableBody.addEventListener("mousedown", (event) => {
  if (event.shiftKey && networkRowOf(event)) event.preventDefault();
});

el.networkTableBody.addEventListener("click", (event) => {
  const row = networkRowOf(event);
  if (!row) return;
  const path = row.dataset.path;
  const toggles = togglesSelection(event);
  if (!event.shiftKey && !toggles) {
    openRequestRow(path);
    return;
  }
  // Modifier clicks change the selection only; the detail view keeps its document.
  if (event.shiftKey) RequestSelection.selectRange(path, visibleRequestEntries(), toggles);
  else RequestSelection.toggle(path);
  syncNetworkRowSelection();
  row.focus({ preventScroll: true });
});

el.networkTableBody.addEventListener("dblclick", (event) => {
  const row = networkRowOf(event);
  if (!row || event.shiftKey || togglesSelection(event)) return;
  const path = row.dataset.path;
  // The first click of the double click already opened it.
  if (state.selectedSection !== "requests" || state.selectedPath !== path) {
    openFile(path, "requests");
  }
  pinTab(tabId(path, "requests"), true);
});

el.networkTableBody.addEventListener("contextmenu", (event) => {
  const row = networkRowOf(event);
  if (!row) return;
  event.preventDefault();
  const path = row.dataset.path;
  // Right-clicking inside the selection keeps it; elsewhere it selects that row alone.
  if (RequestSelection.isSelected(path)) {
    RequestSelection.focus(path);
    syncNetworkRowSelection();
  } else {
    openRequestRow(path);
  }
  // The batch is fixed now, before the menu's async actions run. Hidden selections are left
  // out; the selection itself is not touched by the actions.
  state.contextTarget = {
    type: "file",
    path,
    section: "requests",
    requests: RequestSelection.targetsFor(path, visibleRequestEntries()),
  };
  showContextMenu(event.clientX, event.clientY, "file");
});

el.networkTableBody.addEventListener("keydown", (event) => {
  const row = networkRowOf(event);
  if (row && event.target === row && Keybinds.matches(event, "item.activate")) {
    event.preventDefault();
    openRequestRow(row.dataset.path);
  }
});

el.networkTableBody.addEventListener("focusin", (event) => {
  const row = networkRowOf(event);
  if (row) setNetworkRovingRow(row);
});
