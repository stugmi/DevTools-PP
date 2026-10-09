"use strict";

function requestHost(entry) {
  try {
    return new URL(entry?._record?.request?.url || entry?.sourceURL || "").hostname;
  } catch {
    return "(no domain)";
  }
}

function requestMatchesFilters(path, entry) {
  if (!locationFilterMatches(entry)) return false;
  const record = entry._record;
  if (!record) return false;
  const { domain, type, method, minDuration, maxDuration } = state.requestFilters;
  const kind = requestTypeFor(entry);
  const duration = Number(record.durationMs);
  const text =
    `${path}\n${record.request.method}\n${record.request.url}\n${record.response.status ?? ""}\n${kind}`.toLowerCase();

  if (domain && requestHost(entry) !== domain) return false;
  if (type && kind !== type) return false;
  if (method && record.request.method.toUpperCase() !== method) return false;
  if (minDuration !== "" && (!Number.isFinite(duration) || duration < Number(minDuration)))
    return false;
  if (maxDuration !== "" && (!Number.isFinite(duration) || duration > Number(maxDuration)))
    return false;
  if (state.filterText && !text.includes(state.filterText.toLowerCase())) return false;
  return true;
}

function filteredRequestEntries() {
  return Object.entries(state.requestTree)
    .filter(([path, entry]) => requestMatchesFilters(path, entry))
    .sort(([, a], [, b]) => b._captureSequence - a._captureSequence);
}

function syncRequestFilterOptions() {
  const currentDomain = state.requestFilters.domain;
  const domains = [...new Set(Object.values(state.requestTree).map(requestHost))].sort();
  el.requestDomainFilter.replaceChildren(new Option("All domains", ""));
  for (const domain of domains) el.requestDomainFilter.add(new Option(domain, domain));
  el.requestDomainFilter.value = domains.includes(currentDomain) ? currentDomain : "";
  state.requestFilters.domain = el.requestDomainFilter.value;

  const currentMethod = state.requestFilters.method;
  const methods = [
    ...new Set(
      Object.values(state.requestTree)
        .map((entry) => entry._record?.request?.method?.toUpperCase())
        .filter(Boolean)
    ),
  ].sort();
  el.requestMethodFilter.replaceChildren(new Option("All methods", ""));
  for (const method of methods) el.requestMethodFilter.add(new Option(method, method));
  el.requestMethodFilter.value = methods.includes(currentMethod) ? currentMethod : "";
  state.requestFilters.method = el.requestMethodFilter.value;
}

function requestRowUrlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search || "/";
  } catch {
    return url;
  }
}

function formatTimestamp(capturedAt) {
  const ms = Date.parse(capturedAt);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const NETWORK_SORT_ACCESSORS = {
  name: ([, entry]) => requestRowUrlPath(entry._record.request.url).toLowerCase(),
  status: ([, entry]) => Number(entry._record.response.status),
  type: ([, entry]) => requestTypeFor(entry),
  domain: ([, entry]) => requestHost(entry),
  size: ([, entry]) => Number(entry._record.response.bodySize),
  time: ([, entry]) => Number(entry._record.durationMs),
  timestamp: ([, entry]) => Date.parse(entry._record.capturedAt),
};

function sortRequestEntries(entries) {
  const { key, dir } = state.requestSort;
  if (!key) return entries;
  const accessor = NETWORK_SORT_ACCESSORS[key];
  const sign = dir === "desc" ? -1 : 1;
  return [...entries].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const aMissing = av == null || Number.isNaN(av);
    const bMissing = bv == null || Number.isNaN(bv);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (av < bv) return -sign;
    if (av > bv) return sign;
    return 0;
  });
}

function renderNetworkTable() {
  syncRequestFilterOptions();

  for (const col of el.networkTableHeader.querySelectorAll(".network-col")) {
    const sorted = col.dataset.sortKey === state.requestSort.key;
    col.classList.toggle("sorted", sorted);
    col.classList.toggle("sort-asc", sorted && state.requestSort.dir === "asc");
  }

  const entries = sortRequestEntries(filteredRequestEntries());
  el.networkCount.textContent = String(entries.length);
  el.networkExport.disabled = entries.length === 0;

  el.networkTableBody.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.id = "network-empty-state";
    empty.textContent = Object.keys(state.requestTree).length
      ? "No requests match the current filters"
      : "No requests captured yet";
    el.networkTableBody.appendChild(empty);
    return;
  }

  for (const [path, entry] of entries) {
    const record = entry._record;
    const url = record.request.url;
    const row = document.createElement("div");
    row.className = "network-row network-row-grid";
    if (state.selectedSection === "requests" && state.selectedPath === path) {
      row.classList.add("selected");
    }
    row.dataset.path = path;
    row.dataset.type = "request";
    row.dataset.section = "requests";
    row.title = url;

    const nameCell = document.createElement("span");
    nameCell.className = "network-cell-name";
    const methodEl = document.createElement("span");
    methodEl.className = "network-cell-method";
    methodEl.textContent = record.request.method;
    const urlEl = document.createElement("span");
    urlEl.className = "network-cell-url";
    urlEl.textContent = requestRowUrlPath(url);
    nameCell.append(methodEl, urlEl);

    const statusCell = document.createElement("span");
    statusCell.className = "network-cell-status";
    if (Number(record.response.status) >= 400) statusCell.classList.add("error");
    statusCell.textContent = String(record.response.status ?? "—");

    const typeCell = document.createElement("span");
    typeCell.className = "network-cell-type";
    const typeKind = requestTypeFor(entry);
    typeCell.dataset.type = typeKind;
    typeCell.textContent = typeKind;

    const domainCell = document.createElement("span");
    domainCell.className = "network-cell-domain";
    domainCell.textContent = requestHost(entry);

    const sizeCell = document.createElement("span");
    sizeCell.className = "network-cell-size";
    sizeCell.textContent = Number.isFinite(Number(record.response.bodySize))
      ? formatBytes(Number(record.response.bodySize))
      : "—";

    const timeCell = document.createElement("span");
    timeCell.className = "network-cell-time";
    timeCell.textContent = Number.isFinite(Number(record.durationMs))
      ? `${Number(record.durationMs).toFixed(0)} ms`
      : "—";

    const timestampCell = document.createElement("span");
    timestampCell.className = "network-cell-timestamp";
    timestampCell.textContent = formatTimestamp(record.capturedAt);

    row.append(nameCell, statusCell, typeCell, domainCell, sizeCell, timeCell, timestampCell);

    row.addEventListener("click", () => openFile(path, "requests"));
    row.addEventListener("dblclick", () => {
      openFile(path, "requests");
      pinTab(tabId(path, "requests"), true);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      state.contextTarget = { type: "file", path, section: "requests" };
      openFile(path, "requests");
      showContextMenu(event.clientX, event.clientY, "file");
    });
    el.networkTableBody.appendChild(row);
  }
}

function detailText(className, value, title = "") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = value;
  if (title) node.title = title;
  return node;
}

function requestDetailTable(rows) {
  const table = document.createElement("table");
  table.className = "request-kv";
  for (const [name, value, valueClassName] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    const td = document.createElement("td");
    th.textContent = name;
    const valueWrap = document.createElement("div");
    valueWrap.className = valueClassName
      ? `request-kv-value ${valueClassName}`
      : "request-kv-value";
    valueWrap.textContent =
      value == null ? "—" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    td.appendChild(valueWrap);
    tr.append(th, td);
    table.appendChild(tr);
  }
  return table;
}

// Collapsed-section state is shared across every request (like
// state.requestDetailTab already is) rather than pre-declared on `state` in
// state.js, since this file doesn't own that object's literal.
function collapsedDetailSections() {
  return (state.collapsedDetailSections ??= new Set());
}

function requestDetailSection(title, content) {
  const section = document.createElement("section");
  section.className = "request-detail-section";
  const collapsed = collapsedDetailSections().has(title);
  section.classList.toggle("collapsed", collapsed);

  const heading = document.createElement("h3");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "request-detail-section-toggle";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.innerHTML =
    '<svg width="8" height="8" viewBox="0 0 8 8" fill="none">' +
    '<path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3"' +
    ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const label = document.createElement("span");
  label.textContent = title;
  heading.append(toggle, label);
  heading.addEventListener("click", () => {
    const sections = collapsedDetailSections();
    if (sections.has(title)) sections.delete(title);
    else sections.add(title);
    const nowCollapsed = sections.has(title);
    section.classList.toggle("collapsed", nowCollapsed);
    toggle.setAttribute("aria-expanded", String(!nowCollapsed));
  });

  const body = document.createElement("div");
  body.className = "request-detail-section-body";
  body.appendChild(content);
  section.append(heading, body);
  return section;
}

function requestDetailPre(value, raw = false) {
  const pre = document.createElement("pre");
  pre.className = raw ? "request-raw" : "request-body-content";
  pre.textContent =
    typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
  return pre;
}

function requestDetailEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "request-empty";
  empty.textContent = message;
  return empty;
}

function rawHeaders(startLine, headers) {
  return [startLine, ...(headers || []).map(({ name, value }) => `${name}: ${value}`)].join("\n");
}

function requestBodyLanguage(mimeType) {
  return langFromContentType(mimeType) || "plaintext";
}

function textForBody(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// Bodies up to this size are pretty-printed; beyond it the original text is
// shown as-is so a huge response can't freeze the panel.
const FORMAT_BODY_LIMIT = 2_000_000;

// Pretty-prints a request/response body for the Source view. JSON is detected
// by content as well as MIME type (tRPC/GraphQL clients often send JSON as
// text/plain); form-encoded bodies become one decoded `key=value` per line.
// Anything that can't be formatted is returned unchanged.
function formatBodyText(text, lang, mime) {
  if (typeof text !== "string" || !text || text.length > FORMAT_BODY_LIMIT) return { text, lang };
  const trimmed = text.trim();
  if (lang === "json" || (lang === "plaintext" && /^[[{]/.test(trimmed))) {
    try {
      return { text: formatJsonText(trimmed) + "\n", lang: "json" };
    } catch {
      // not valid JSON -- fall through
    }
  }
  if (/x-www-form-urlencoded/i.test(mime || "")) {
    const decode = (part) => {
      try {
        return decodeURIComponent(part.replace(/\+/g, " "));
      } catch {
        return part;
      }
    };
    return { text: trimmed.split("&").map(decode).join("\n") + "\n", lang };
  }
  if (lang !== "json" && lang !== "plaintext") {
    const pretty = tryPretty(text, lang);
    if (pretty.ok) return { text: pretty.content, lang };
  }
  return { text, lang };
}

function setRequestFormat(enabled) {
  state.requestDetailFormat = Boolean(enabled);
  if (el.requestFormatToggle) el.requestFormatToggle.checked = state.requestDetailFormat;
  showSelectedRequestTab();
}

// ── JSON tree view (Parsed mode for object/array bodies) ────────────────────

function jsonValuePreview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  const shown = keys.slice(0, 3).join(", ");
  return `{${shown}${keys.length > 3 ? ", …" : ""}}`;
}

function appendJsonScalar(row, value) {
  const span = document.createElement("span");
  span.className = `json-value json-value-${value === null ? "null" : typeof value}`;
  span.textContent = value === undefined ? "undefined" : JSON.stringify(value);
  row.appendChild(span);
}

function buildJsonNode(key, value) {
  const isExpandable = value !== null && typeof value === "object";
  const wrapper = document.createElement("div");
  wrapper.className = "json-node";

  const row = document.createElement("div");
  row.className = "json-row";

  if (isExpandable) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "json-toggle";
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "json-toggle-spacer";
    row.appendChild(spacer);
  }

  if (key != null) {
    const keySpan = document.createElement("span");
    keySpan.className = "json-key";
    keySpan.textContent = `${key}: `;
    row.appendChild(keySpan);
  }

  if (!isExpandable) {
    appendJsonScalar(row, value);
    wrapper.appendChild(row);
    return wrapper;
  }

  const preview = document.createElement("span");
  preview.className = "json-preview";
  preview.textContent = jsonValuePreview(value);
  row.appendChild(preview);

  const children = document.createElement("div");
  children.className = "json-children collapsed";
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  for (const [childKey, childValue] of entries) {
    children.appendChild(buildJsonNode(childKey, childValue));
  }

  row.addEventListener("click", () => {
    const collapsed = children.classList.toggle("collapsed");
    row.classList.toggle("expanded", !collapsed);
  });

  wrapper.append(row, children);
  return wrapper;
}

function buildJsonTree(value) {
  const container = document.createElement("div");
  container.className = "json-tree";
  if (value === null || typeof value !== "object") {
    container.appendChild(buildJsonNode(null, value));
    return container;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (entries.length === 0) {
    container.appendChild(
      requestDetailEmpty(Array.isArray(value) ? "Empty array" : "Empty object")
    );
    return container;
  }
  for (const [key, childValue] of entries) {
    container.appendChild(buildJsonNode(key, childValue));
  }
  return container;
}

let payloadViewer = null;
let responseViewer = null;

function ensurePayloadViewer() {
  payloadViewer ??= RequestViewer.mount(document.getElementById("request-payload-viewer"));
  return payloadViewer;
}

function ensureResponseViewer() {
  responseViewer ??= RequestViewer.mount(document.getElementById("request-response-viewer"));
  return responseViewer;
}

function requestDetailPanel(tab) {
  return document.getElementById(`request-detail-panel-${tab}`);
}

function bodyParseKind(bodyValue, lang, allowHtml) {
  if (allowHtml && lang === "html" && typeof bodyValue === "string") return "html";
  if (bodyValue !== null && typeof bodyValue === "object") return "tree";
  return "none";
}

// Payload's and Response's Source/Parsed toggle are independent -- keyed by
// tab so switching tabs (or requests) never leaks one's toggle state into
// the other.
function bodyPreviewState() {
  return (state.requestBodyPreviewByTab ??= { payload: false, response: false });
}

function getBodyPreview(tab) {
  return !!bodyPreviewState()[tab];
}

function setBodyPreview(tab, value) {
  bodyPreviewState()[tab] = value;
}

function updateBodyViewToggle(entry) {
  const toggle = document.getElementById("request-body-view-toggle");
  if (!toggle) return;
  const tab = state.requestDetailTab;
  if (tab !== "payload" && tab !== "response") {
    toggle.hidden = true;
    return;
  }
  const record = entry._record;
  const isResponse = tab === "response";
  const bodyValue = isResponse ? record.response.body : record.request.body;
  const mime = isResponse ? record.response.bodyMimeType : record.request.bodyMimeType;
  const lang = requestBodyLanguage(mime);
  const kind = bodyParseKind(bodyValue, lang, isResponse);
  toggle.hidden = kind === "none";
  if (kind === "none") return;

  const buttons = toggle.querySelectorAll("button");
  const parsedActive = getBodyPreview(tab);
  buttons[0].classList.toggle("active", !parsedActive);
  buttons[1].classList.toggle("active", parsedActive);
}

function renderHeadersPanel(entry, raw) {
  const panel = requestDetailPanel("headers");
  if (!panel) return;
  panel.replaceChildren();
  const record = entry._record;
  const request = record.request;
  const response = record.response;
  const general = [
    ["Request URL", request.url],
    ["Request method", request.method],
    [
      "Status code",
      `${response.status ?? "—"} ${response.statusText || ""}`.trim(),
      `request-kv-status${Number(response.status) >= 400 ? " error" : ""}`,
    ],
    ["Remote domain", requestHost(entry)],
    ["Resource type", requestTypeFor(entry)],
    ["HTTP version", response.httpVersion || request.httpVersion],
    ["Captured at", record.capturedAt],
    ["Redirect URL", response.redirectURL],
    ["Response size", response.bodySize == null ? null : `${response.bodySize} B`],
  ];
  panel.appendChild(requestDetailSection("General", requestDetailTable(general)));
  if (raw) {
    panel.append(
      requestDetailSection(
        "Request headers",
        requestDetailPre(
          request.headersText ||
            rawHeaders(
              `${request.method} ${request.url} ${request.httpVersion || ""}`.trim(),
              request.headers
            ),
          true
        )
      ),
      requestDetailSection(
        "Response headers",
        requestDetailPre(
          response.headersText ||
            rawHeaders(
              `${response.httpVersion || ""} ${response.status ?? ""} ${response.statusText || ""}`.trim(),
              response.headers
            ),
          true
        )
      )
    );
  } else {
    panel.append(
      requestDetailSection(
        "Request headers",
        request.headers.length
          ? requestDetailTable(request.headers.map(({ name, value }) => [name, value]))
          : requestDetailEmpty("No request headers")
      ),
      requestDetailSection(
        "Response headers",
        response.headers.length
          ? requestDetailTable(response.headers.map(({ name, value }) => [name, value]))
          : requestDetailEmpty("No response headers")
      ),
      requestDetailSection(
        "Request cookies",
        request.cookies.length
          ? requestDetailTable(request.cookies.map(({ name, value }) => [name, value]))
          : requestDetailEmpty("No request cookies")
      ),
      requestDetailSection(
        "Response cookies",
        response.cookies.length
          ? requestDetailTable(response.cookies.map(({ name, value }) => [name, value]))
          : requestDetailEmpty("No response cookies")
      )
    );
  }
}

// Shared by Payload/Response: renders one body area that's either the raw
// text viewer, a JSON tree, or (Response only) a sandboxed HTML preview
// frame, showing exactly one of the three depending on the Source/Parsed
// toggle and what the content actually is.
function renderBodyArea({ treeHost, viewerHost, frame, bodyValue, lang, mime, wrap, preview }) {
  const kind = bodyParseKind(bodyValue, lang, !!frame);
  const showParsed = kind !== "none" && !!preview;

  if (frame) {
    frame.hidden = !(showParsed && kind === "html");
    if (showParsed && kind === "html") frame.srcdoc = bodyValue;
    else frame.removeAttribute("srcdoc");
  }

  treeHost.hidden = !(showParsed && kind === "tree");
  if (showParsed && kind === "tree") {
    treeHost.replaceChildren(buildJsonTree(bodyValue));
  }

  const showViewer = !(showParsed && (kind === "html" || kind === "tree"));
  viewerHost.hidden = !showViewer;
  if (showViewer) {
    const viewer =
      viewerHost === document.getElementById("request-payload-viewer")
        ? ensurePayloadViewer()
        : ensureResponseViewer();
    const shown = state.requestDetailFormat
      ? formatBodyText(textForBody(bodyValue), lang || "plaintext", mime)
      : { text: textForBody(bodyValue), lang: lang || "plaintext" };
    viewer.setContent(shown.text, shown.lang);
    viewer.setWrap(!!wrap);
  }
}

function renderPayloadPanel(entry, raw) {
  const panel = requestDetailPanel("payload");
  if (!panel) return;
  const record = entry._record;
  const request = record.request;

  const meta = document.getElementById("request-payload-meta");
  meta.replaceChildren();
  let rawQuery = "";
  try {
    rawQuery = new URL(request.url).search.slice(1);
  } catch {
    rawQuery = "";
  }
  const queryContent = raw
    ? requestDetailPre(rawQuery, true)
    : request.queryParams.length
      ? requestDetailTable(request.queryParams.map(({ name, value }) => [name, value]))
      : requestDetailEmpty("No query parameters");
  meta.appendChild(requestDetailSection("Query parameters", queryContent));

  const treeHost = document.getElementById("request-payload-tree");
  const viewerHost = document.getElementById("request-payload-viewer");
  const splitter = document.getElementById("request-payload-splitter");
  meta.style.height = state.payloadMetaHeight ? `${state.payloadMetaHeight}px` : "";

  if (request.body == null || request.body === "") {
    splitter.hidden = true;
    meta.style.height = "";
    treeHost.hidden = true;
    viewerHost.hidden = true;
    meta.appendChild(requestDetailEmpty("No request payload"));
    return;
  }

  splitter.hidden = false;
  const preview = getBodyPreview("payload");
  const bodyValue = preview ? request.body : (entry._rawRequestBody ?? textForBody(request.body));
  renderBodyArea({
    treeHost,
    viewerHost,
    frame: null,
    bodyValue,
    lang: requestBodyLanguage(request.bodyMimeType),
    mime: request.bodyMimeType,
    wrap: state.requestDetailWrap,
    preview,
  });
}

function renderResponsePanel(entry) {
  const panel = requestDetailPanel("response");
  if (!panel) return;
  const record = entry._record;
  const response = record.response;
  const treeHost = document.getElementById("request-response-tree");
  const viewerHost = document.getElementById("request-response-viewer");
  const frame = document.getElementById("request-response-frame");

  const showPlainText = (text) => {
    treeHost.hidden = true;
    frame.hidden = true;
    frame.removeAttribute("srcdoc");
    viewerHost.hidden = false;
    const viewer = ensureResponseViewer();
    viewer.setContent(text, "plaintext");
    viewer.setWrap(!!state.requestDetailWrap);
  };

  if (entry._responseStatus === "loading") {
    showPlainText("Loading response content…");
    return;
  }
  if (entry._responseStatus === "unavailable") {
    showPlainText(
      requestTypeFor(entry) === "socket"
        ? "Streaming socket bodies are not requested; handshake headers remain available."
        : "Response content is unavailable in the DevTools cache."
    );
    return;
  }
  if (response.body == null || response.body === "") {
    showPlainText("Response has no body");
    return;
  }

  const lang = requestBodyLanguage(response.bodyMimeType);
  const preview = getBodyPreview("response");
  const bodyValue = preview
    ? response.body
    : (entry._rawResponseBody ?? textForBody(response.body));
  renderBodyArea({
    treeHost,
    viewerHost,
    frame,
    bodyValue,
    lang,
    mime: response.bodyMimeType,
    wrap: state.requestDetailWrap,
    preview,
  });
}

function renderTimingPanel(entry) {
  const panel = requestDetailPanel("timing");
  if (!panel) return;
  panel.replaceChildren();
  const record = entry._record;
  const timingRows = [
    ["Captured at", record.capturedAt],
    ["Total duration", record.durationMs == null ? null : `${record.durationMs} ms`],
    ...Object.entries(record.timings || {}).map(([name, value]) => [
      name,
      value == null || value < 0 ? "—" : `${value} ms`,
    ]),
  ];
  panel.appendChild(requestDetailSection("Timing", requestDetailTable(timingRows)));
}

document.getElementById("request-body-view-toggle")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-body-view]");
  if (!button) return;
  const tab = state.requestDetailTab;
  if (tab !== "payload" && tab !== "response") return;
  setBodyPreview(tab, button.dataset.bodyView === "parsed");
  showSelectedRequestTab();
});

el.requestFormatToggle.addEventListener("change", () => {
  setRequestFormat(el.requestFormatToggle.checked);
});

// Draggable divider between the query-parameters block and the payload body.
(function initPayloadSplitter() {
  const handle = document.getElementById("request-payload-splitter");
  const meta = document.getElementById("request-payload-meta");
  const panel = requestDetailPanel("payload");
  if (!handle || !meta || !panel) return;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const startY = event.clientY;
    const startHeight = meta.offsetHeight;
    const onMove = (moveEvent) => {
      const max = Math.max(48, panel.clientHeight - 140);
      const next = Math.max(28, Math.min(max, startHeight + moveEvent.clientY - startY));
      state.payloadMetaHeight = next;
      meta.style.height = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
  handle.addEventListener("dblclick", () => {
    state.payloadMetaHeight = null;
    meta.style.height = "";
  });
})();

document.getElementById("request-wrap-toggle")?.addEventListener("change", (event) => {
  state.requestDetailWrap = event.target.checked;
  showSelectedRequestTab();
});

function renderRequestDetailBody(entry) {
  const raw = state.requestDetailRaw;
  el.requestDetailBody.classList.toggle("wrap", !!state.requestDetailWrap);

  for (const tab of ["headers", "payload", "response", "timing"]) {
    const panel = requestDetailPanel(tab);
    if (panel) panel.hidden = tab !== state.requestDetailTab;
  }
  updateBodyViewToggle(entry);
  const bodyTab = state.requestDetailTab === "payload" || state.requestDetailTab === "response";
  el.requestFormatToggle.closest("label").hidden = !bodyTab;
  el.requestFormatToggle.checked = state.requestDetailFormat;

  if (state.requestDetailTab === "headers") return renderHeadersPanel(entry, raw);
  if (state.requestDetailTab === "payload") return renderPayloadPanel(entry, raw);
  if (state.requestDetailTab === "response") return renderResponsePanel(entry);
  return renderTimingPanel(entry);
}

function renderRequestDetails(entry) {
  const record = entry._record;
  state.lastPreviewOriginal = entry.content;
  state.lastPreviewText = entry.content;
  state.lastPreviewLang = "json";
  state.lastPreviewBadge = "REQUEST";

  el.previewActions.classList.add("request-actions");
  el.previewActions.style.display = "flex";
  el.previewFooter.classList.add("request-actions");
  el.previewPlaceholder.style.display = "none";
  el.editorContainer.style.display = "none";
  SourceEditor.hide().catch(() => {});
  el.previewImageWrap.style.display = "none";
  el.requestDetail.hidden = false;

  const urlField = document.createElement("input");
  urlField.type = "text";
  urlField.className = "request-summary-url";
  urlField.readOnly = true;
  urlField.spellcheck = false;
  urlField.value = record.request.url;
  urlField.title = record.request.url;
  urlField.addEventListener("focus", () => urlField.select());
  urlField.addEventListener("click", () => urlField.select());

  el.requestSummary.replaceChildren(
    detailText("request-summary-method", record.request.method),
    urlField
  );
  for (const button of el.requestDetailTabs.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.requestTab === state.requestDetailTab);
  }
  el.requestRawToggle.checked = state.requestDetailRaw;
  const wrapToggle = document.getElementById("request-wrap-toggle");
  if (wrapToggle) wrapToggle.checked = !!state.requestDetailWrap;
  renderRequestDetailBody(entry);

  el.previewLangBadge.textContent = "REQUEST";
  el.previewMeta.textContent = `${record.request.method} · ${record.response.status ?? "—"} · ${record.durationMs == null ? "—" : `${Number(record.durationMs).toFixed(0)} ms`}`;
  el.previewFooter.style.display = "flex";
}

async function showSelectedRequestTab() {
  if (state.selectedSection !== "requests") return;
  const entry = state.requestTree[state.selectedPath];
  if (!entry) return;
  renderRequestDetails(entry);
  if (state.requestDetailTab !== "response" || entry._responseStatus !== "idle") return;
  const pending = loadRequestResponse(entry);
  renderRequestDetailBody(entry);
  await pending;
  if (state.selectedSection === "requests" && state.requestTree[state.selectedPath] === entry) {
    renderRequestDetails(entry);
  }
}
