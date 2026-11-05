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
      entry._reqHost = new URL(entry?._record?.request?.url || entry?.sourceURL || "").hostname;
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
      `${path}\n${request.method}\n${request.url}\n${response.status ?? ""}\n${requestKind(entry)}`.toLowerCase();
  }
  return entry._searchText;
}

// -- Filtering --

function requestMatchesFilters(path, entry) {
  const record = entry._record;
  if (!record) return false;
  const { domain, type, method, minDuration, maxDuration } = state.requestFilters;

  if (domain && requestHost(entry) !== domain) return false;
  if (type && requestKind(entry) !== type) return false;
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
  return locationFilterMatches(entry);
}

// The filtered list is recomputed only when the captured set or a filter changed.
let requestListCache = { tree: null, regex: null, key: "", entries: [] };

function requestListKey() {
  const f = state.requestFilters;
  const loc = state.locationFilter;
  return [
    state.requestCaptureSequence,
    f.domain,
    f.type,
    f.method,
    f.minDuration,
    f.maxDuration,
    state.filterText,
    loc.mode,
    loc.value,
  ].join("\u0001");
}

// Newest-first [path, entry] pairs that pass every filter.
function filteredRequestEntries() {
  const key = requestListKey();
  const cache = requestListCache;
  if (
    cache.tree === state.requestTree &&
    cache.regex === state.locationFilter.regex &&
    cache.key === key
  ) {
    return cache.entries;
  }
  const entries = Object.entries(state.requestTree)
    .filter(([path, entry]) => requestMatchesFilters(path, entry))
    .sort(([, a], [, b]) => b._captureSequence - a._captureSequence);
  requestListCache = { tree: state.requestTree, regex: state.locationFilter.regex, key, entries };
  return entries;
}

// -- Filter dropdown options --

let filterOptionsSource = { tree: null, sequence: -1 };
let filterOptionsKey = "";

function setFilterOptions(select, allLabel, values, current) {
  select.replaceChildren(new Option(allLabel, ""));
  for (const value of values) select.add(new Option(value, value));
  // A selection that no longer exists stays visible so the UI matches the active filter.
  if (current && !values.includes(current)) select.add(new Option(current, current));
  select.value = current;
}

// Rebuilds the domain and method options only when a host or method appeared or vanished.
function syncRequestFilterOptions() {
  if (
    filterOptionsSource.tree === state.requestTree &&
    filterOptionsSource.sequence === state.requestCaptureSequence
  ) {
    return;
  }
  filterOptionsSource = { tree: state.requestTree, sequence: state.requestCaptureSequence };

  const hosts = new Set();
  const methods = new Set();
  for (const entry of Object.values(state.requestTree)) {
    hosts.add(requestHost(entry));
    const method = entry._record?.request?.method?.toUpperCase();
    if (method) methods.add(method);
  }
  const domains = [...hosts].sort();
  const methodList = [...methods].sort();
  const key = `${domains.join("\u0001")}\u0002${methodList.join("\u0001")}`;
  if (key === filterOptionsKey) return;
  filterOptionsKey = key;

  setFilterOptions(el.requestDomainFilter, "All domains", domains, state.requestFilters.domain);
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

// -- Rows --

function statusClassFor(status) {
  if (status === null) return "";
  if (status >= 400) return "error";
  if (status >= 300) return "redirect";
  if (status >= 200) return "ok";
  return "";
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
  row.dataset.path = path;
  row.dataset.type = "request";
  row.dataset.section = "requests";
  row.title = record.request.url;

  const nameCell = networkCell("network-cell-name", "");
  const methodEl = document.createElement("span");
  methodEl.className = "network-cell-method";
  methodEl.textContent = record.request.method;
  const urlEl = document.createElement("span");
  urlEl.className = "network-cell-url";
  urlEl.textContent = requestRowUrlPath(entry);
  nameCell.append(methodEl, urlEl);

  const status = finiteOrNull(record.response.status);
  const statusCell = networkCell("network-cell-status", status === null ? "—" : String(status));
  const statusClass = statusClassFor(status);
  if (statusClass) statusCell.classList.add(statusClass);

  const kind = requestKind(entry);
  const typeCell = networkCell("network-cell-type", kind);
  typeCell.dataset.type = kind;

  const size = finiteOrNull(record.response.bodySize);
  const duration = finiteOrNull(record.durationMs);

  row.append(
    nameCell,
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
let renderedSortMark = "";
// Scroll-to-selection triggers: the view of the list (filters + sort) and its visibility.
// The capture sequence is left out so new requests never move the user's scroll position.
let renderedViewKey = "";
let networkWasVisible = false;

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

// Marks the selected row (class + aria-current) and keeps one row in the tab order.
function syncNetworkRowSelection() {
  const body = el.networkTableBody;
  const selected = state.listSelection.network
    ? networkRows.get(state.listSelection.network)?.row
    : null;
  const active = selected?.isConnected ? selected : null;
  for (const row of body.querySelectorAll(".network-row.selected")) {
    if (row === active) continue;
    row.classList.remove("selected");
    row.removeAttribute("aria-current");
  }
  if (active) {
    active.classList.add("selected");
    active.setAttribute("aria-current", "true");
  }
  const roving = networkRovingRow?.isConnected ? networkRovingRow : null;
  setNetworkRovingRow(active || roving || body.querySelector(".network-row"));
  return active;
}

function networkViewKey() {
  const f = state.requestFilters;
  const loc = state.locationFilter;
  const sort = state.requestSort;
  return [
    f.domain,
    f.type,
    f.method,
    f.minDuration,
    f.maxDuration,
    state.filterText,
    loc.mode,
    loc.value,
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
    networkRowsTree = state.requestTree;
  }

  const entries = sortRequestEntries(filteredRequestEntries());
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

el.networkTableBody.addEventListener("click", (event) => {
  const row = networkRowOf(event);
  if (row) openFile(row.dataset.path, "requests");
});

el.networkTableBody.addEventListener("dblclick", (event) => {
  const row = networkRowOf(event);
  if (!row) return;
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
  state.contextTarget = { type: "file", path, section: "requests" };
  openFile(path, "requests");
  showContextMenu(event.clientX, event.clientY, "file");
});

el.networkTableBody.addEventListener("keydown", (event) => {
  const row = networkRowOf(event);
  if (row && event.target === row && Keybinds.matches(event, "item.activate")) {
    event.preventDefault();
    openFile(row.dataset.path, "requests");
  }
});

el.networkTableBody.addEventListener("focusin", (event) => {
  const row = networkRowOf(event);
  if (row) setNetworkRovingRow(row);
});
