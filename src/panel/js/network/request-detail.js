// Request detail view: Headers, Payload, Response, Preview, Initiator and Timing panels plus
// footer controls. Loaded last of the network files (after cookies.js, request-body.js,
// body-trees.js and initiator.js). Wiring for the body toggle, payload splitter and footer
// buttons runs at load time.

"use strict";

function detailText(className, value, title = "") {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = value;
  if (title) node.title = title;
  return node;
}

// Collapsed-section state is shared by every request (like state.requestDetailTab) and created
// lazily here because state.js owns the `state` literal.
function collapsedDetailSections() {
  return (state.collapsedDetailSections ??= new Set());
}

function requestDetailPre(value, raw = false) {
  const pre = document.createElement("pre");
  pre.className = raw ? "request-raw" : "request-body-content";
  pre.textContent = valueToText(value);
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

// Source / Parsed toggle for Payload and Response, only for bodies that parse. Hex is not a view
// here: it is a language in the footer menu, and while it is shown the toggle is hidden.
function updateBodyViewToggle(entry, tab) {
  const toggle = document.getElementById("request-body-view-toggle");
  if (!toggle) return;
  const view = isBodyTab(tab) && !isBodyPlaceholder(entry, tab) ? bodyViewFor(entry, tab) : null;
  toggle.hidden = !view || view === "hex" || !parsedBodyFor(entry, tab);
  if (toggle.hidden) return;
  for (const button of toggle.querySelectorAll("button[data-body-view]")) {
    const active = button.dataset.bodyView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

// One hex viewer per body tab, mounted on first use into its own host.
const hexViewers = {};

function hexHostFor(tab) {
  return document.getElementById(`request-${tab}-hex`);
}

function ensureHexViewer(tab) {
  hexViewers[tab] ??= HexViewer.mount(hexHostFor(tab));
  return hexViewers[tab];
}

function hideHexHost(tab) {
  const host = hexHostFor(tab);
  if (host) host.hidden = true;
}

// The Hex view: the byte viewer, or the reason there are no bytes to show.
function renderHexArea({ entry, tab, treeHost, viewerHost }) {
  const view = hexViewFor(entry, tab);
  viewerHost.hidden = true;
  if (!view.bytes) {
    hideHexHost(tab);
    hexViewers[tab]?.clear();
    treeHost.hidden = false;
    treeHost.replaceChildren(requestDetailEmpty(view.reason));
    return;
  }
  treeHost.hidden = true;
  hexHostFor(tab).hidden = false;
  ensureHexViewer(tab).setBytes(view.bytes, { note: view.note });
}

// -- Headers tab (modelled on Chrome DevTools) --

function statusDot(status) {
  const dot = document.createElement("span");
  dot.className = `request-status-dot${Number(status) >= 400 ? " error" : ""}`;
  return dot;
}

// General rows: empty values (remote address, redirect URL) are dropped rather than shown as
// a dash.
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

// Cap on the key column width of the key/value tables, in characters.
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

// DevTools-style key/value table: bold keys, dimmed colon, plain values that always wrap.
function requestHeaderTable(rows, keyChars = sharedKeyChars(rows)) {
  const table = document.createElement("div");
  table.className = "kv-table";
  table.style.setProperty("--kv-key-chars", String(keyChars));
  for (const [name, value, options] of rows) {
    const row = document.createElement("div");
    row.className = "kv-row";
    // The colon lives inside the key cell so it hugs the key text while values still line up.
    const key = document.createElement("span");
    key.className = "kv-key";
    const colon = document.createElement("span");
    colon.className = "kv-colon";
    colon.textContent = ":";
    key.append(String(name), colon);
    const val = document.createElement("span");
    val.className = "kv-value";
    if (options && "status" in options) val.appendChild(statusDot(options.status));
    val.append(value == null || value === "" ? "—" : valueToText(value));
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

  // One key column shared by every table, so values line up from General through Response
  // headers to Request headers.
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

// Which tabs a request actually has: Payload only with params or a body, Cookies only when
// any were sent or set. Initiator is always listed; it explains itself when nothing was
// captured.
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
  tabs.push("response", "initiator");
  if (cookies.request.length || cookies.response.length) tabs.push("cookies");
  tabs.push("timing");
  return tabs;
}

// Shared by Payload and Response: renders one body area, either the source text viewer, the
// parsed tree (JSON value or HTML/XML document) or the hex viewer, depending on the language
// override (Hex included), the Source/Parsed toggle and whether the body parses at all.
function renderBodyArea({ entry, tab, treeHost, viewerHost, sourceText, mime }) {
  if (bodyViewFor(entry, tab) === "hex") {
    renderHexArea({ entry, tab, treeHost, viewerHost });
    return;
  }
  hideHexHost(tab);
  const parsed = shownParsedBody(entry, tab);
  treeHost.hidden = !parsed;
  viewerHost.hidden = !!parsed;
  if (parsed) {
    // The tree is kept per entry and tab, so re-renders keep which nodes are expanded.
    const tree = bodyTreeFor(entry, tab, parsed);
    if (treeHost.firstElementChild !== tree || treeHost.childElementCount !== 1) {
      treeHost.replaceChildren(tree);
    }
    return;
  }
  const viewer = tab === "payload" ? ensurePayloadViewer() : ensureResponseViewer();
  const { lang, forced } = bodyLanguageFor(entry, tab);
  const shown = state.requestDetailFormat
    ? formattedBodyFor(entry, tab, sourceText, lang, mime, forced)
    : { text: sourceText, lang };
  viewer.setContent(shown.text, shown.lang);
  viewer.setWrap(!!state.requestDetailWrap);
}

function renderPayloadPanel(entry) {
  const panel = requestDetailPanel("payload");
  if (!panel) return;
  const { request } = entry._record;

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
    hideHexHost("payload");
    return;
  }

  splitter.hidden = !meta.childElementCount;
  renderBodyArea({
    entry,
    tab: "payload",
    treeHost,
    viewerHost,
    sourceText: entry._rawRequestBody ?? valueToText(request.body),
    mime: request.bodyMimeType,
  });
}

// Status text shown instead of the response body (by Response and Preview) while it loads,
// when it can't be read, or when there is none; else null.
function responsePlaceholderText(entry) {
  if (entry._responseStatus === "loading") return "Loading response content…";
  if (entry._responseStatus === "unavailable") {
    if (entry._responseError) return entry._responseError;
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
    viewerHost.hidden = true;
    hideHexHost("response");
    treeHost.hidden = false;
    treeHost.replaceChildren(requestDetailEmpty(placeholder));
    return;
  }

  renderBodyArea({
    entry,
    tab: "response",
    treeHost,
    viewerHost,
    sourceText: entry._rawResponseBody ?? valueToText(response.body),
    mime: response.bodyMimeType,
  });
}

// What the Preview tab renders: "html" (HTML by MIME type, content sniffing or the language
// override), "svg" (SVG by MIME type or a root <svg> in XML), "image" (any other image/* type);
// null for the rest.
const SVG_ROOT = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>|\s)*<svg[\s>]/i;

function responsePreviewKind(entry) {
  const { body, bodyMimeType } = entry._record.response;
  const mime = baseMime(bodyMimeType);
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  const { lang } = bodyLanguageFor(entry, "response");
  if (lang === "html") return "html";
  if (lang === "xml" && typeof body === "string" && SVG_ROOT.test(body.slice(0, 4096))) {
    return "svg";
  }
  return null;
}

// Policy for the preview frame: no network access at all (no remote images, styles, fonts or
// frames), only inline styles and data: images. Placed after a leading doctype so the preview
// document keeps standards mode.
const PREVIEW_CSP =
  '<meta http-equiv="Content-Security-Policy" ' +
  "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";
const PREVIEW_DOCTYPE = /^\s*<!doctype[^>]*>/i;
const PREVIEW_IMAGE_MIME = /^image\/[\w.+-]+$/i;
const PREVIEW_BASE64 = /^[A-Za-z0-9+/=\s]*$/;

function withPreviewPolicy(html) {
  const doctype = PREVIEW_DOCTYPE.exec(html);
  if (!doctype) return PREVIEW_CSP + html;
  return doctype[0] + PREVIEW_CSP + html.slice(doctype[0].length);
}

// Document for the sandboxed preview frame (no scripts run, no network), or null when the body
// can't be shown that way (e.g. an image body that isn't base64, or a malformed MIME/data).
function responsePreviewDocument(entry) {
  const { body, bodyMimeType } = entry._record.response;
  const kind = responsePreviewKind(entry);
  if (kind === "image") {
    if (!isBase64Body(body)) return null;
    const mime = baseMime(bodyMimeType);
    if (!PREVIEW_IMAGE_MIME.test(mime) || !PREVIEW_BASE64.test(body.data)) return null;
    return withPreviewPolicy(
      "<!doctype html><style>html,body{height:100%;margin:0}" +
        "body{display:grid;place-items:center}img{max-width:100%;max-height:100%}</style>" +
        `<img src="data:${mime};base64,${body.data}" alt="">`
    );
  }
  return typeof body === "string" ? withPreviewPolicy(body) : null;
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

function renderInitiatorPanel(entry) {
  const panel = requestDetailPanel("initiator");
  if (panel) panel.replaceChildren(RequestInitiator.render(entry));
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
  const tab = currentRequestTab();
  if (!isBodyTab(tab)) return;
  setBodyParsed(tab, button.dataset.bodyView === "parsed");
  showSelectedRequestTab({ chrome: false });
});

// Draggable divider between the query-parameters block and the payload body.
(function initPayloadSplitter() {
  const handle = document.getElementById("request-payload-splitter");
  const meta = document.getElementById("request-payload-meta");
  const panel = requestDetailPanel("payload");
  if (!handle || !meta || !panel) return;

  // Meta block height, clamped like the pointer drag, mirrored to aria-valuenow.
  const setMetaHeight = (height) => {
    const max = Math.max(48, panel.clientHeight - 140);
    const next = Math.max(28, Math.min(max, height));
    state.payloadMetaHeight = next;
    meta.style.height = `${next}px`;
    handle.setAttribute("aria-valuenow", String(Math.round(next)));
  };

  handle.tabIndex = 0;
  handle.addEventListener("keydown", (event) => {
    const up = Keybinds.matches(event, "splitter.up");
    if (!up && !Keybinds.matches(event, "splitter.down")) return;
    event.preventDefault();
    const step = event.shiftKey ? 64 : 16;
    setMetaHeight(meta.offsetHeight + (up ? -step : step));
  });

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const startY = event.clientY;
    const startHeight = meta.offsetHeight;
    const onMove = (moveEvent) => setMetaHeight(startHeight + moveEvent.clientY - startY);
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
    handle.removeAttribute("aria-valuenow");
  });
})();

function setRequestFormat(enabled) {
  state.requestDetailFormat = Boolean(enabled);
  showSelectedRequestTab({ chrome: false });
}

function setRequestWrap(enabled) {
  state.requestDetailWrap = Boolean(enabled);
  showSelectedRequestTab({ chrome: false });
}

// Wrap and Format live in the footer (like the file editor's controls) and only apply to the
// Source view of Payload and Response; the language override (which includes Hex) applies to
// every view.
function updateRequestFooterControls(entry, tab) {
  const bodyTab = isBodyTab(tab);
  const view = bodyTab && !isBodyPlaceholder(entry, tab) ? bodyViewFor(entry, tab) : null;
  for (const [button, on] of [
    [el.btnRequestFormat, state.requestDetailFormat],
    [el.btnRequestWrap, state.requestDetailWrap],
  ]) {
    button.hidden = view !== "source";
    button.classList.toggle("active", Boolean(on));
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }

  const select = el.selRequestLang;
  select.hidden = !view;
  if (select.hidden) return;
  const override = requestBodyOverrides(entry)[tab] ?? "auto";
  const { lang } = bodyLanguageFor(entry, tab);
  const label =
    view === "hex" ? "Hex" : (BODY_LANG_OPTIONS.find(([id]) => id === lang)?.[1] ?? lang);
  select.options[0].textContent = override === "auto" ? `Auto (${label})` : "Auto";
  // Base64 decoding is only offered when the body text actually decodes (or is already chosen).
  const base64Option = [...select.options].find((option) => option.value === "hex-base64");
  if (base64Option) {
    base64Option.hidden = override !== "hex-base64" && !bodyDecodesAsBase64(entry, tab);
  }
  select.value = override;
}

function populateRequestLangSelect() {
  const select = el.selRequestLang;
  select.replaceChildren(
    ...[["auto", "Auto"], ...BODY_LANG_OPTIONS].map(([id, label]) => new Option(label, id))
  );
  select.addEventListener("change", () => {
    const tab = currentRequestTab();
    const entry = state.requestTree[state.selectedPath];
    if (!entry || !isBodyTab(tab)) return;
    requestBodyOverrides(entry)[tab] = select.value;
    showSelectedRequestTab({ chrome: false });
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

// Tabs are kept as the user's preference (state.requestDetailTab); a request without that tab
// shows Headers for now without losing the preference.
function renderRequestTabs(entry) {
  const tabs = availableRequestTabs(entry);
  const active = tabs.includes(state.requestDetailTab) ? state.requestDetailTab : "headers";
  for (const button of el.requestDetailTabs.querySelectorAll("button")) {
    const name = button.dataset.requestTab;
    button.hidden = !tabs.includes(name);
    button.classList.toggle("active", name === active);
    button.setAttribute("aria-selected", String(name === active));
  }
  return active;
}

// The tab actually shown for the selected request (see renderRequestTabs).
function currentRequestTab(entry = state.requestTree[state.selectedPath]) {
  if (!entry) return state.requestDetailTab;
  return availableRequestTabs(entry).includes(state.requestDetailTab)
    ? state.requestDetailTab
    : "headers";
}

// Tab strip, footer controls and the active tab's panel. Wrap/format/language toggles call only
// this, not renderRequestChrome.
function renderRequestDetailBody(entry) {
  const tab = renderRequestTabs(entry);
  for (const name of [
    "headers",
    "payload",
    "preview",
    "response",
    "initiator",
    "cookies",
    "timing",
  ]) {
    const panel = requestDetailPanel(name);
    if (panel) panel.hidden = name !== tab;
  }
  updateBodyViewToggle(entry, tab);
  updateRequestFooterControls(entry, tab);
  state.lastPreviewText = entry.content;

  if (tab === "headers") return renderHeadersPanel(entry);
  if (tab === "payload") return renderPayloadPanel(entry);
  if (tab === "preview") return renderPreviewPanel(entry);
  if (tab === "response") return renderResponsePanel(entry);
  if (tab === "initiator") return renderInitiatorPanel(entry);
  if (tab === "cookies") return renderCookiesPanel(entry);
  return renderTimingPanel(entry);
}

// Summary row (method, URL), preview state and header badges: only changes with the selection.
function renderRequestChrome(entry) {
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

  el.previewLangBadge.textContent = "REQUEST";
  el.previewMeta.textContent = `${record.request.method} · ${record.response.status ?? "—"} · ${record.durationMs == null ? "—" : `${Number(record.durationMs).toFixed(0)} ms`}`;
  el.previewFooter.style.display = "flex";
}

// Re-renders the selected request's detail body, e.g. after an export finished loading its
// response. No-op outside the Network workspace.
function rerenderSelectedRequest() {
  if (state.selectedSection !== "requests") return;
  const entry = state.requestTree[state.selectedPath];
  if (entry) renderRequestDetailBody(entry);
}

// Renders the selected request once. Response and Preview start the response load first, so
// that single render shows the loading placeholder, and the body is re-rendered after the load
// settles (including a load started elsewhere, e.g. by Export). `chrome: false` skips the
// summary row for toggles that only affect the body.
async function showSelectedRequestTab({ chrome = true } = {}) {
  if (state.selectedSection !== "requests") return;
  const entry = state.requestTree[state.selectedPath];
  if (!entry) return;
  const tab = currentRequestTab(entry);
  if ((tab === "response" || tab === "preview") && entry._responseStatus === "idle") {
    loadRequestResponse(entry);
  }
  const pending = entry._responseStatus === "loading" ? entry._responsePromise : null;
  if (chrome) renderRequestChrome(entry);
  renderRequestDetailBody(entry);
  if (!pending) return;
  await pending;
  if (state.selectedSection === "requests" && state.requestTree[state.selectedPath] === entry) {
    renderRequestDetailBody(entry);
  }
}

el.btnRequestFormat.addEventListener("click", () => setRequestFormat(!state.requestDetailFormat));
el.btnRequestWrap.addEventListener("click", () => setRequestWrap(!state.requestDetailWrap));
populateRequestLangSelect();

// The footer Copy button copies the hex viewer's selection (the whole body when nothing is
// selected) as spaced hex. This capture listener runs before main.js reads
// `state.lastPreviewText` on the same click.
el.btnCopy.addEventListener(
  "click",
  () => {
    if (state.selectedSection !== "requests") return;
    const entry = state.requestTree[state.selectedPath];
    const tab = currentRequestTab();
    if (!entry || !isBodyTab(tab) || isBodyPlaceholder(entry, tab)) return;
    if (bodyViewFor(entry, tab) !== "hex" || !hexViewFor(entry, tab).bytes) {
      return;
    }
    const text = hexViewers[tab]?.selectionText("hex");
    if (text) state.lastPreviewText = text;
  },
  true
);
