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

// Collapsed-section state is shared across every request (like
// state.requestDetailTab already is) rather than pre-declared on `state` in
// state.js, since this file doesn't own that object's literal.
function collapsedDetailSections() {
  return (state.collapsedDetailSections ??= new Set());
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

// ── Headers tab (modelled on Chrome DevTools) ───────────────────────────────

function statusDot(status) {
  const dot = document.createElement("span");
  dot.className = `request-status-dot${Number(status) >= 400 ? " error" : ""}`;
  return dot;
}

// General: only rows that carry information. Method/URL are already in the
// summary bar above the tabs, so they are not repeated, and empty values
// (redirect URL, HTTP version, ...) are dropped rather than shown as a dash.
function generalRows(entry) {
  const record = entry._record;
  const { request, response } = record;
  const rows = [];
  rows.push(["Request URL", request.url]);
  rows.push(["Request Method", request.method]);
  const status = `${response.status ?? "—"} ${response.statusText || ""}`.trim();
  rows.push(["Status Code", status, { status: response.status }]);
  if (response.remoteAddress) rows.push(["Remote Address", response.remoteAddress]);
  const policy = response.headers.find((h) => h.name.toLowerCase() === "referrer-policy");
  if (policy) rows.push(["Referrer Policy", policy.value]);
  if (response.redirectURL) rows.push(["Redirect URL", response.redirectURL]);
  return rows;
}

// A DevTools-style key/value table. Keys are bold and bright, the colon is
// dimmed, values are plain; values always wrap.
function requestHeaderTable(rows) {
  const table = document.createElement("div");
  table.className = "kv-table";
  const longest = rows.reduce((max, [name]) => Math.max(max, String(name).length), 0);
  table.style.setProperty("--kv-key-chars", String(Math.min(Math.max(longest, 6), 32)));
  for (const [name, value, options] of rows) {
    const row = document.createElement("div");
    row.className = "kv-row";
    // The colon lives inside the key cell so it hugs the key text, while the
    // values still line up in one column.
    const key = document.createElement("span");
    key.className = "kv-key";
    const colon = document.createElement("span");
    colon.className = "kv-colon";
    colon.textContent = ":";
    key.append(String(name), colon);
    const val = document.createElement("span");
    val.className = "kv-value";
    if (options && "status" in options) val.appendChild(statusDot(options.status));
    val.append(
      value == null || value === ""
        ? "—"
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2)
    );
    row.append(key, val);
    table.appendChild(row);
  }
  return table;
}

// Collapsible section with an optional "Raw" checkbox in its header.
function requestDetailSection(title, content, { rawKey = null } = {}) {
  const section = document.createElement("section");
  section.className = "request-detail-section";
  const collapsed = collapsedDetailSections().has(title);
  section.classList.toggle("collapsed", collapsed);

  const heading = document.createElement("div");
  heading.className = "request-detail-section-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "request-detail-section-toggle";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.innerHTML =
    '<svg width="8" height="8" viewBox="0 0 8 8" fill="none">' +
    '<path d="M2 1l4 3-4 3" stroke="currentColor" stroke-width="1.3"' +
    ' stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    `<span class="request-detail-section-title"></span>`;
  toggle.querySelector(".request-detail-section-title").textContent = title;
  const flip = () => {
    const sections = collapsedDetailSections();
    if (sections.has(title)) sections.delete(title);
    else sections.add(title);
    const nowCollapsed = sections.has(title);
    section.classList.toggle("collapsed", nowCollapsed);
    toggle.setAttribute("aria-expanded", String(!nowCollapsed));
  };
  toggle.addEventListener("click", flip);
  heading.appendChild(toggle);

  if (rawKey) {
    const label = document.createElement("label");
    label.className = "request-raw-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(state.requestRawSections[rawKey]);
    input.addEventListener("change", () => {
      state.requestRawSections[rawKey] = input.checked;
      showSelectedRequestTab();
    });
    label.append(input, "Raw");
    heading.appendChild(label);
  }

  const body = document.createElement("div");
  body.className = "request-detail-section-body";
  body.appendChild(content);
  section.append(heading, body);
  return section;
}

function renderHeadersPanel(entry) {
  const panel = requestDetailPanel("headers");
  if (!panel) return;
  panel.replaceChildren();
  const { request, response } = entry._record;

  panel.appendChild(requestDetailSection("General", requestHeaderTable(generalRows(entry))));

  const responseStart =
    `${response.httpVersion || ""} ${response.status ?? ""} ${response.statusText || ""}`.trim();
  const requestStart = `${request.method} ${request.url} ${request.httpVersion || ""}`.trim();
  const sections = [
    ["Response headers", "response", response.headers, response.headersText, responseStart],
    ["Request headers", "request", request.headers, request.headersText, requestStart],
  ];
  for (const [title, rawKey, headers, headersText, startLine] of sections) {
    let content;
    if (state.requestRawSections[rawKey]) {
      content = requestDetailPre(headersText || rawHeaders(startLine, headers), true);
    } else if (headers.length) {
      content = requestHeaderTable(headers.map(({ name, value }) => [name, value]));
    } else {
      content = requestDetailEmpty(`No ${title.toLowerCase()}`);
    }
    panel.appendChild(requestDetailSection(title, content, { rawKey }));
  }
}

// ── Cookies tab ──────────────────────────────────────────────────────────────

function cookieTable(cookies) {
  const table = document.createElement("div");
  table.className = "cookie-table";
  const head = document.createElement("div");
  head.className = "cookie-row cookie-head";
  // The two flag columns are narrow, so they get a one-letter heading with the
  // full name in the tooltip.
  const columns = [
    ["Name", "Name"],
    ["Value", "Value"],
    ["Path", "Path"],
    ["Domain", "Domain"],
    ["Expires", "Expires"],
    ["H", "HttpOnly"],
    ["S", "Secure"],
    ["SameSite", "SameSite"],
  ];
  for (const [label, title] of columns) {
    const cell = document.createElement("span");
    cell.textContent = label;
    cell.title = title;
    head.appendChild(cell);
  }
  table.appendChild(head);
  for (const cookie of cookies) {
    const row = document.createElement("div");
    row.className = "cookie-row";
    const cells = [
      cookie.name,
      cookie.value,
      cookie.path,
      cookie.domain,
      cookie.expires,
      cookie.httpOnly ? "✓" : "",
      cookie.secure ? "✓" : "",
      cookie.sameSite,
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement("span");
      cell.className = index === 0 ? "cookie-name" : "";
      cell.textContent = value == null ? "" : String(value);
      cell.title = cell.textContent;
      row.appendChild(cell);
    });
    table.appendChild(row);
  }
  return table;
}

function requestCookies(entry) {
  const { request, response } = entry._record;
  return { request: request.cookies || [], response: response.cookies || [] };
}

function renderCookiesPanel(entry) {
  const panel = requestDetailPanel("cookies");
  if (!panel) return;
  panel.replaceChildren();
  const cookies = requestCookies(entry);
  if (cookies.request.length) {
    panel.appendChild(requestDetailSection("Request cookies", cookieTable(cookies.request)));
  }
  if (cookies.response.length) {
    panel.appendChild(requestDetailSection("Response cookies", cookieTable(cookies.response)));
  }
}

// Which tabs a request actually has: Payload only with params or a body,
// Cookies only when any were sent or set.
function availableRequestTabs(entry) {
  const { request } = entry._record;
  const cookies = requestCookies(entry);
  const tabs = ["headers"];
  if (
    (request.queryParams && request.queryParams.length) ||
    (request.body != null && request.body !== "")
  ) {
    tabs.push("payload");
  }
  tabs.push("response");
  if (cookies.request.length || cookies.response.length) tabs.push("cookies");
  tabs.push("timing");
  return tabs;
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

function renderPayloadPanel(entry) {
  const panel = requestDetailPanel("payload");
  if (!panel) return;
  const record = entry._record;
  const request = record.request;

  const meta = document.getElementById("request-payload-meta");
  meta.replaceChildren();
  if (request.queryParams && request.queryParams.length) {
    meta.appendChild(
      requestDetailSection(
        "Query string parameters",
        requestHeaderTable(request.queryParams.map(({ name, value }) => [name, value]))
      )
    );
  }

  const treeHost = document.getElementById("request-payload-tree");
  const viewerHost = document.getElementById("request-payload-viewer");
  const splitter = document.getElementById("request-payload-splitter");
  meta.style.height = state.payloadMetaHeight ? `${state.payloadMetaHeight}px` : "";

  if (request.body == null || request.body === "") {
    splitter.hidden = true;
    meta.style.height = "";
    treeHost.hidden = true;
    viewerHost.hidden = true;
    return;
  }

  splitter.hidden = !meta.childElementCount;
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
  panel.appendChild(requestDetailSection("Timing", requestHeaderTable(timingRows)));
}

document.getElementById("request-body-view-toggle")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-body-view]");
  if (!button) return;
  const tab = state.requestDetailTab;
  if (tab !== "payload" && tab !== "response") return;
  setBodyPreview(tab, button.dataset.bodyView === "parsed");
  showSelectedRequestTab();
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

function setRequestWrap(enabled) {
  state.requestDetailWrap = Boolean(enabled);
  showSelectedRequestTab();
}

// Wrap and Format live in the footer (like the file editor's controls) and
// only apply to the Source view of Payload/Response.
function updateRequestFooterControls(entry) {
  const tab = state.requestDetailTab;
  const bodyTab = tab === "payload" || tab === "response";
  const sourceView = bodyTab && !getBodyPreview(tab) && !isBodyPlaceholder(entry, tab);
  for (const [button, on] of [
    [el.btnRequestFormat, state.requestDetailFormat],
    [el.btnRequestWrap, state.requestDetailWrap],
  ]) {
    button.hidden = !sourceView;
    button.classList.toggle("active", Boolean(on));
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

// True when the response tab shows a status message instead of a real body.
function isBodyPlaceholder(entry, tab) {
  if (tab !== "response") return false;
  const { response } = entry._record;
  return (
    entry._responseStatus === "loading" ||
    entry._responseStatus === "unavailable" ||
    response.body == null ||
    response.body === ""
  );
}

function renderRequestTabs(entry) {
  const tabs = availableRequestTabs(entry);
  if (!tabs.includes(state.requestDetailTab)) state.requestDetailTab = "headers";
  for (const button of el.requestDetailTabs.querySelectorAll("button")) {
    const name = button.dataset.requestTab;
    button.hidden = !tabs.includes(name);
    button.classList.toggle("active", name === state.requestDetailTab);
  }
}

function renderRequestDetailBody(entry) {
  renderRequestTabs(entry);
  for (const tab of ["headers", "payload", "response", "cookies", "timing"]) {
    const panel = requestDetailPanel(tab);
    if (panel) panel.hidden = tab !== state.requestDetailTab;
  }
  updateBodyViewToggle(entry);
  updateRequestFooterControls(entry);

  if (state.requestDetailTab === "headers") return renderHeadersPanel(entry);
  if (state.requestDetailTab === "payload") return renderPayloadPanel(entry);
  if (state.requestDetailTab === "response") return renderResponsePanel(entry);
  if (state.requestDetailTab === "cookies") return renderCookiesPanel(entry);
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

el.btnRequestFormat.addEventListener("click", () => setRequestFormat(!state.requestDetailFormat));
el.btnRequestWrap.addEventListener("click", () => setRequestWrap(!state.requestDetailWrap));
