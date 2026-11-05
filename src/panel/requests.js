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

// Languages offered by the footer override. "auto" (the default) detects from
// the MIME type, then the body content, and falls back to plain text.
const BODY_LANG_OPTIONS = [
  ["plaintext", "Plain text"],
  ["json", "JSON"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["html", "HTML"],
  ["xml", "XML"],
  ["css", "CSS"],
  ["yaml", "YAML"],
  ["markdown", "Markdown"],
  ["graphql", "GraphQL"],
  ["shell", "Shell"],
];

// React Server Components "flight" lines, e.g. `1:"$Sreact.fragment"`,
// `0:{"buildId":...}`, `11:I[51957,[...],""]`, `2:T179d,...`.
const FLIGHT_LINE = /^[0-9a-f]+:(?:[[{"]|I\[|HL\[|T[0-9a-f]+,|null$|true$|false$|-?\d)/;
const JS_START =
  /^(?:["']use strict["']|\/\*|\/\/|!function|\(function|\(\(|(?:var|let|const|class|import|export)[\s{*]|(?:async\s+)?function[\s(*])/;

// Content-based guess used when the MIME type says nothing useful (a custom
// type like text/x-component, text/plain, or none at all). Returns null when
// nothing is recognised so the caller can fall back to plain text.
function sniffBodyLang(body) {
  if (body !== null && typeof body === "object") return "json";
  if (typeof body !== "string") return null;
  const head = body.slice(0, 4096).trimStart();
  if (!head) return null;
  if (head[0] === "{" || head[0] === "[") {
    if (body.length <= FORMAT_BODY_LIMIT) {
      try {
        JSON.parse(body);
        return "json";
      } catch {
        // not plain JSON -- keep sniffing
      }
    }
  }
  if (/^<!doctype\s+html|^<html[\s>]/i.test(head)) return "html";
  if (/^<\?xml|^<svg[\s>]/i.test(head)) return "xml";
  if (FLIGHT_LINE.test(head) || JS_START.test(head)) return "javascript";
  return null;
}

function requestBodyLanguage(mimeType, body) {
  try {
    return langFromContentType(mimeType) || sniffBodyLang(body) || "plaintext";
  } catch {
    return "plaintext";
  }
}

function requestBodyOverrides(entry) {
  return (entry._bodyLang ??= { payload: "auto", response: "auto" });
}

// Language for a Payload/Response body: the manual override if one is set,
// otherwise auto-detection. `forced` tells the formatter not to second-guess it.
function bodyLanguageFor(entry, tab) {
  const { request, response } = entry._record;
  const side = tab === "response" ? response : request;
  const override = requestBodyOverrides(entry)[tab];
  if (override && override !== "auto") return { lang: override, forced: true };
  return { lang: requestBodyLanguage(side.bodyMimeType, side.body), forced: false };
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
// Anything that can't be formatted is returned unchanged. `forced` (a manual
// language override) disables the content-based guessing.
function formatBodyText(text, lang, mime, forced = false) {
  if (typeof text !== "string" || !text || text.length > FORMAT_BODY_LIMIT) return { text, lang };
  if (forced && lang === "plaintext") return { text, lang };
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
  // RSC flight data is line-oriented, not JS statements -- the beautifier would mangle it.
  const flight = /x-component/i.test(mime || "") || FLIGHT_LINE.test(trimmed.slice(0, 4096));
  if (lang !== "json" && lang !== "plaintext" && !flight) {
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

// ── Markup tree view (Parsed mode for HTML/XML bodies) ──────────────────────

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function markupSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

// Child nodes worth a row: elements, non-blank text, comments, CDATA and
// processing instructions. Indentation-only text nodes are dropped.
function markupChildren(node) {
  return Array.from(node.childNodes).filter((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.data.trim() !== "";
    return [
      Node.ELEMENT_NODE,
      Node.CDATA_SECTION_NODE,
      Node.COMMENT_NODE,
      Node.PROCESSING_INSTRUCTION_NODE,
      Node.DOCUMENT_TYPE_NODE,
    ].includes(child.nodeType);
  });
}

function markupTagName(element, isHtml) {
  return isHtml ? element.localName : element.nodeName;
}

// `<name attr="value" ...>` (or `.../>` when `selfClose`) as one inline span.
function markupOpenTag(element, isHtml, selfClose = false) {
  const tag = document.createElement("span");
  tag.className = "markup-tag";
  tag.append(
    markupSpan("markup-bracket", "<"),
    markupSpan("markup-name", markupTagName(element, isHtml))
  );
  for (const attr of element.attributes) {
    tag.append(" ", markupSpan("markup-attr", attr.name));
    tag.append(markupSpan("markup-bracket", '="'));
    tag.append(markupSpan("markup-attr-value", attr.value));
    tag.append(markupSpan("markup-bracket", '"'));
  }
  tag.append(markupSpan("markup-bracket", selfClose ? "/>" : ">"));
  return tag;
}

function markupCloseTag(element, isHtml) {
  const tag = document.createElement("span");
  tag.className = "markup-tag";
  tag.append(
    markupSpan("markup-bracket", "</"),
    markupSpan("markup-name", markupTagName(element, isHtml)),
    markupSpan("markup-bracket", ">")
  );
  return tag;
}

function markupLeafText(node) {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
      return markupSpan("json-value-string", node.data.trim());
    case Node.CDATA_SECTION_NODE:
      return markupSpan("json-value-string", `<![CDATA[${node.data}]]>`);
    case Node.COMMENT_NODE:
      return markupSpan("markup-comment", `<!--${node.data}-->`);
    case Node.PROCESSING_INSTRUCTION_NODE:
      return markupSpan("markup-comment", `<?${node.target} ${node.data}?>`);
    case Node.DOCUMENT_TYPE_NODE:
      return markupSpan("markup-comment", `<!DOCTYPE ${node.name}>`);
    default:
      return markupSpan("markup-comment", node.textContent);
  }
}

function markupRow(...content) {
  const row = document.createElement("div");
  row.className = "json-row";
  row.append(...content);
  return row;
}

function markupSpacer() {
  return markupSpan("json-toggle-spacer", "");
}

// One DOM node of the tree. Elements whose only content is text stay on one
// line; others expand to their children plus a closing-tag row. Children are
// built on first expand so a large document stays cheap until explored.
function buildMarkupNode(node, isHtml, expanded = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "json-node";
  if (node.nodeType !== Node.ELEMENT_NODE) {
    wrapper.appendChild(markupRow(markupSpacer(), markupLeafText(node)));
    return wrapper;
  }

  const children = markupChildren(node);
  const name = markupTagName(node, isHtml);
  if (children.length === 0) {
    const selfClose = !isHtml;
    const row = markupRow(markupSpacer(), markupOpenTag(node, isHtml, selfClose));
    if (isHtml && !HTML_VOID_ELEMENTS.has(name)) {
      row.lastChild.appendChild(markupCloseTag(node, isHtml));
    }
    wrapper.appendChild(row);
    return wrapper;
  }
  const onlyText =
    children.length === 1 &&
    (children[0].nodeType === Node.TEXT_NODE || children[0].nodeType === Node.CDATA_SECTION_NODE);
  if (onlyText) {
    const line = markupOpenTag(node, isHtml);
    line.append(markupLeafText(children[0]), markupCloseTag(node, isHtml));
    wrapper.appendChild(markupRow(markupSpacer(), line));
    return wrapper;
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "json-toggle";
  const preview = document.createElement("span");
  preview.className = "json-preview";
  preview.textContent = `…</${name}>`;
  const row = markupRow(toggle, markupOpenTag(node, isHtml), preview);

  const childHost = document.createElement("div");
  childHost.className = "json-children collapsed";
  const close = markupRow(markupSpacer(), markupCloseTag(node, isHtml));
  close.classList.add("markup-close");

  let built = false;
  const setExpanded = (open) => {
    if (open && !built) {
      built = true;
      childHost.append(...children.map((child) => buildMarkupNode(child, isHtml)));
    }
    childHost.classList.toggle("collapsed", !open);
    row.classList.toggle("expanded", open);
  };
  row.addEventListener("click", () => setExpanded(!row.classList.contains("expanded")));
  setExpanded(expanded);

  wrapper.append(row, childHost, close);
  return wrapper;
}

// The document's top-level nodes (doctype, comments, root element), with the
// root element expanded like the JSON tree's root properties.
function buildMarkupTree({ doc, isHtml, error }) {
  const container = document.createElement("div");
  container.className = "json-tree";
  if (error) {
    container.appendChild(requestDetailEmpty(`Could not parse XML: ${error}`));
    return container;
  }
  for (const node of markupChildren(doc)) {
    container.appendChild(buildMarkupNode(node, isHtml, node === doc.documentElement));
  }
  return container;
}

// What the Parsed view shows for a body: a JSON value (structured bodies and
// JSON text) or a parsed HTML/XML document; null when there is nothing to parse.
function parseBody(body, lang) {
  if (body == null || body === "") return null;
  if (typeof body === "object") return { kind: "json", value: body };
  if (typeof body !== "string") return null;
  if (lang === "json") {
    try {
      return { kind: "json", value: JSON.parse(body) };
    } catch {
      return null;
    }
  }
  if (lang === "html" || lang === "xml") {
    const isHtml = lang === "html";
    const doc = new DOMParser().parseFromString(body, isHtml ? "text/html" : "application/xml");
    const failure = isHtml ? null : doc.querySelector("parsererror");
    const error = failure
      ? (failure.querySelector("div") ?? failure).textContent.trim() || "invalid XML"
      : null;
    return { kind: "markup", doc, isHtml, error };
  }
  return null;
}

// Parsing is cached per tab until the body or the chosen language changes, so
// toggle-visibility checks and re-renders don't re-parse a large body.
function parsedBodyFor(entry, tab) {
  const side = tab === "response" ? entry._record.response : entry._record.request;
  const { lang } = bodyLanguageFor(entry, tab);
  const cache = (entry._parsedBody ??= {});
  const hit = cache[tab];
  if (hit && hit.body === side.body && hit.lang === lang) return hit.result;
  const result = parseBody(side.body, lang);
  cache[tab] = { body: side.body, lang, result };
  return result;
}

// Payload's and Response's Source/Parsed toggle are independent -- keyed by
// tab so switching tabs (or requests) never leaks one's toggle state into
// the other.
function bodyParsedState() {
  return (state.requestBodyParsedByTab ??= { payload: false, response: false });
}

function getBodyParsed(tab) {
  return !!bodyParsedState()[tab];
}

function setBodyParsed(tab, value) {
  bodyParsedState()[tab] = value;
}

// The parsed body the tab currently shows instead of source text: only when
// Parsed is selected and the body actually parses.
function shownParsedBody(entry, tab) {
  return getBodyParsed(tab) ? parsedBodyFor(entry, tab) : null;
}

function updateBodyViewToggle(entry) {
  const toggle = document.getElementById("request-body-view-toggle");
  if (!toggle) return;
  const tab = state.requestDetailTab;
  if (tab !== "payload" && tab !== "response") {
    toggle.hidden = true;
    return;
  }
  toggle.hidden = isBodyPlaceholder(entry, tab) || !parsedBodyFor(entry, tab);
  if (toggle.hidden) return;

  const buttons = toggle.querySelectorAll("button");
  const parsedActive = getBodyParsed(tab);
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
const KV_KEY_MAX_CHARS = 33;

// Width (in characters) of the key column needed for these rows. Pass the
// result of `sharedKeyChars()` as `keyChars` to give several tables one column.
function sharedKeyChars(...rowLists) {
  let longest = 0;
  for (const rows of rowLists) {
    for (const [name] of rows) longest = Math.max(longest, String(name).length);
  }
  return Math.min(Math.max(longest, 6), KV_KEY_MAX_CHARS);
}

function requestHeaderTable(rows, keyChars = sharedKeyChars(rows)) {
  const table = document.createElement("div");
  table.className = "kv-table";
  table.style.setProperty("--kv-key-chars", String(keyChars));
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
function requestDetailSection(title, content, { rawKey = null, actions = null } = {}) {
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

  if (actions) {
    actions.classList.add("request-detail-section-actions");
    heading.appendChild(actions);
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

  // One key column shared by every table, so values line up from General
  // through Response headers to Request headers.
  const general = generalRows(entry);
  const toRows = (headers) => headers.map(({ name, value }) => [name, value]);
  const keyChars = sharedKeyChars(general, toRows(response.headers), toRows(request.headers));

  panel.appendChild(requestDetailSection("General", requestHeaderTable(general, keyChars)));

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
      content = requestHeaderTable(toRows(headers), keyChars);
    } else {
      content = requestDetailEmpty(`No ${title.toLowerCase()}`);
    }
    panel.appendChild(requestDetailSection(title, content, { rawKey }));
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
  if (responsePreviewKind(entry)) tabs.push("preview");
  tabs.push("response");
  if (cookies.request.length || cookies.response.length) tabs.push("cookies");
  tabs.push("timing");
  return tabs;
}

// Shared by Payload/Response: renders one body area that's either the raw
// text viewer or the parsed tree (JSON value or HTML/XML document), depending
// on the Source/Parsed toggle and whether the body parses at all.
function renderBodyArea({ entry, tab, treeHost, viewerHost, sourceText, lang, forced, mime }) {
  const parsed = shownParsedBody(entry, tab);
  treeHost.hidden = !parsed;
  viewerHost.hidden = !!parsed;
  if (parsed) {
    treeHost.replaceChildren(
      parsed.kind === "json" ? buildJsonTree(parsed.value) : buildMarkupTree(parsed)
    );
    return;
  }
  const viewer = tab === "payload" ? ensurePayloadViewer() : ensureResponseViewer();
  const shown = state.requestDetailFormat
    ? formatBodyText(sourceText, lang || "plaintext", mime, forced)
    : { text: sourceText, lang: lang || "plaintext" };
  viewer.setContent(shown.text, shown.lang);
  viewer.setWrap(!!state.requestDetailWrap);
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
  renderBodyArea({
    entry,
    tab: "payload",
    treeHost,
    viewerHost,
    sourceText: entry._rawRequestBody ?? textForBody(request.body),
    ...bodyLanguageFor(entry, "payload"),
    mime: request.bodyMimeType,
  });
}

// Status text shown instead of the response body (by Response and Preview)
// while it loads, when it can't be read, or when there is none; else null.
function responsePlaceholderText(entry) {
  if (entry._responseStatus === "loading") return "Loading response content…";
  if (entry._responseStatus === "unavailable") {
    return requestTypeFor(entry) === "socket"
      ? "Streaming socket bodies are not requested; handshake headers remain available."
      : "Response content is unavailable in the DevTools cache.";
  }
  const { body } = entry._record.response;
  if (body == null || body === "") return "Response has no body";
  return null;
}

function renderResponsePanel(entry) {
  const panel = requestDetailPanel("response");
  if (!panel) return;
  const response = entry._record.response;
  const treeHost = document.getElementById("request-response-tree");
  const viewerHost = document.getElementById("request-response-viewer");

  const placeholder = responsePlaceholderText(entry);
  if (placeholder) {
    treeHost.hidden = true;
    viewerHost.hidden = false;
    const viewer = ensureResponseViewer();
    viewer.setContent(placeholder, "plaintext");
    viewer.setWrap(!!state.requestDetailWrap);
    return;
  }

  renderBodyArea({
    entry,
    tab: "response",
    treeHost,
    viewerHost,
    sourceText: entry._rawResponseBody ?? textForBody(response.body),
    ...bodyLanguageFor(entry, "response"),
    mime: response.bodyMimeType,
  });
}

// What the Preview tab renders: "html" (the page itself, HTML by MIME type,
// content sniffing or the language override), "svg" (SVG by MIME type or a
// root <svg> in XML), "image" (any other image/* type); null for the rest.
const SVG_ROOT = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>|\s)*<svg[\s>]/i;

function responsePreviewKind(entry) {
  const { body, bodyMimeType } = entry._record.response;
  const mime = (bodyMimeType || "").split(";")[0].trim().toLowerCase();
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  const { lang } = bodyLanguageFor(entry, "response");
  if (lang === "html") return "html";
  if (lang === "xml" && typeof body === "string" && SVG_ROOT.test(body.slice(0, 4096))) {
    return "svg";
  }
  return null;
}

// Document for the sandboxed preview frame (no scripts run), or null when the
// body can't be shown that way (e.g. an image body that isn't base64).
function responsePreviewDocument(entry) {
  const { body, bodyMimeType } = entry._record.response;
  const kind = responsePreviewKind(entry);
  if (kind === "image") {
    if (!body || typeof body !== "object" || body.encoding !== "base64") return null;
    const mime = (bodyMimeType || "").split(";")[0].trim();
    return (
      "<!doctype html><style>html,body{height:100%;margin:0}" +
      "body{display:grid;place-items:center}img{max-width:100%;max-height:100%}</style>" +
      `<img src="data:${mime};base64,${body.data}" alt="">`
    );
  }
  return typeof body === "string" ? body : null;
}

function renderPreviewPanel(entry) {
  const frame = document.getElementById("request-preview-frame");
  const message = document.getElementById("request-preview-message");
  const text = responsePlaceholderText(entry);
  const doc = text ? null : responsePreviewDocument(entry);
  frame.hidden = doc == null;
  message.hidden = doc != null;
  if (doc == null) {
    frame.removeAttribute("srcdoc");
    message.replaceChildren(requestDetailEmpty(text || "Response can't be previewed"));
    return;
  }
  // Re-renders (live capture updates, toggles) must not reload the page.
  if (frame.srcdoc !== doc) frame.srcdoc = doc;
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
  setBodyParsed(tab, button.dataset.bodyView === "parsed");
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
  const sourceView = bodyTab && !isBodyPlaceholder(entry, tab) && !shownParsedBody(entry, tab);
  for (const [button, on] of [
    [el.btnRequestFormat, state.requestDetailFormat],
    [el.btnRequestWrap, state.requestDetailWrap],
  ]) {
    button.hidden = !sourceView;
    button.classList.toggle("active", Boolean(on));
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }

  const select = el.selRequestLang;
  select.hidden = !(bodyTab && !isBodyPlaceholder(entry, tab));
  if (select.hidden) return;
  const override = requestBodyOverrides(entry)[tab];
  const { lang } = bodyLanguageFor(entry, tab);
  const label = BODY_LANG_OPTIONS.find(([id]) => id === lang)?.[1] ?? lang;
  select.options[0].textContent = override === "auto" ? `Auto (${label})` : "Auto";
  select.value = override;
}

function populateRequestLangSelect() {
  const select = el.selRequestLang;
  select.replaceChildren(
    ...[["auto", "Auto"], ...BODY_LANG_OPTIONS].map(([id, label]) => new Option(label, id))
  );
  select.addEventListener("change", () => {
    const tab = state.requestDetailTab;
    const entry = state.requestTree[state.selectedPath];
    if (!entry || (tab !== "payload" && tab !== "response")) return;
    requestBodyOverrides(entry)[tab] = select.value;
    showSelectedRequestTab();
  });
}

// True when the Payload/Response tab shows a status message instead of a real body.
function isBodyPlaceholder(entry, tab) {
  if (tab === "payload") {
    const { body } = entry._record.request;
    return body == null || body === "";
  }
  return tab === "response" && responsePlaceholderText(entry) != null;
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
  for (const tab of ["headers", "payload", "preview", "response", "cookies", "timing"]) {
    const panel = requestDetailPanel(tab);
    if (panel) panel.hidden = tab !== state.requestDetailTab;
  }
  updateBodyViewToggle(entry);
  updateRequestFooterControls(entry);

  if (state.requestDetailTab === "headers") return renderHeadersPanel(entry);
  if (state.requestDetailTab === "payload") return renderPayloadPanel(entry);
  if (state.requestDetailTab === "preview") return renderPreviewPanel(entry);
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
  const bodyTab = state.requestDetailTab === "response" || state.requestDetailTab === "preview";
  if (!bodyTab || entry._responseStatus !== "idle") return;
  const pending = loadRequestResponse(entry);
  renderRequestDetailBody(entry);
  await pending;
  if (state.selectedSection === "requests" && state.requestTree[state.selectedPath] === entry) {
    renderRequestDetails(entry);
  }
}

el.btnRequestFormat.addEventListener("click", () => setRequestFormat(!state.requestDetailFormat));
el.btnRequestWrap.addEventListener("click", () => setRequestWrap(!state.requestDetailWrap));
populateRequestLangSelect();
