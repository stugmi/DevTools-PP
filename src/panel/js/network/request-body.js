// Request/response body language, formatting, parsing, and Source/Parsed/Hex view state.
// Uses filetype.js, json-payload.js, and hexdump.js; rendered by request-detail.js.

"use strict";

// Languages offered by the footer override. "auto" (the default) detects from the MIME type,
// then the body content, and falls back to plain text.
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

// Bodies up to this size are pretty-printed; larger ones are shown as-is so a huge response
// can't freeze the panel.
const FORMAT_BODY_LIMIT = 2_000_000;

// Larger bodies are not parsed for the Parsed view. JSON gets a higher cap because its tree is
// built lazily; HTML/XML go through DOMParser, which builds the whole document up front.
const PARSE_JSON_LIMIT = 16_000_000;
const PARSE_MARKUP_LIMIT = 4_000_000;

// React Server Components "flight" lines, e.g. `1:"$Sreact.fragment"`,
// `0:{"buildId":...}`, `11:I[51957,[...],""]`, `2:T179d,...`.
const FLIGHT_LINE = /^[0-9a-f]+:(?:[[{"]|I\[|HL\[|T[0-9a-f]+,|null$|true$|false$|-?\d)/;
const FLIGHT_NEXT_LINE = /^[0-9a-f]+:/;
const JS_START =
  /^(?:["']use strict["']|\/\*|\/\/|!function|\(function|\(\(|(?:var|let|const|class|import|export)[\s{*]|(?:async\s+)?function[\s(*])/;
const LEADING_COMMENTS = /^(?:<!--[\s\S]*?-->\s*)+/;
const HTML_START =
  /^(?:<!doctype\s+html|<(?:html|head|body|div|span|p|a|ul|ol|li|table|form|section|main|nav|header|footer|script|style|link|meta|h[1-6]|img|button|input)[\s>/])/i;
const XML_START = /^(?:<\?xml|<svg[\s>])/i;

// Flight data needs a second signal: a plain `12:30 meeting` also matches the first-line shape,
// so the line after it must look like a flight line too.
function looksLikeFlight(text) {
  const trimmed = text.trimStart();
  if (!FLIGHT_LINE.test(trimmed.slice(0, 4096))) return false;
  const newline = trimmed.indexOf("\n");
  return newline >= 0 && FLIGHT_NEXT_LINE.test(trimmed.slice(newline + 1, newline + 40));
}

// `{encoding: "base64", data}` is how binary response bodies are stored.
function isBase64Body(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    body.encoding === "base64" &&
    typeof body.data === "string" &&
    Object.keys(body).length === 2
  );
}

// Content-based guess for when the MIME type says nothing useful (a custom type like
// text/x-component, text/plain, or none). Returns { lang, json } where `lang` is null when
// nothing is recognised so the caller can fall back to plain text, and `json` is the parsed
// value when JSON detection already had to parse the text (to seed the Parsed cache).
function sniffBody(body, mime) {
  if (body !== null && typeof body === "object") {
    if (isBase64Body(body) || /x-www-form-urlencoded/i.test(mime || "")) {
      return { lang: "plaintext" };
    }
    return { lang: "json" };
  }
  if (typeof body !== "string") return { lang: null };
  const head = body.slice(0, 4096).trimStart();
  if (!head) return { lang: null };
  if ((head[0] === "{" || head[0] === "[") && body.length <= FORMAT_BODY_LIMIT) {
    const parsed = parseJsonPayload(body);
    if (parsed) return { lang: "json", json: parsed.value };
  }
  const markup = head[0] === "<" ? head.replace(LEADING_COMMENTS, "") : head;
  if (HTML_START.test(markup)) return { lang: "html" };
  if (XML_START.test(markup)) return { lang: "xml" };
  if (looksLikeFlight(body)) return { lang: "javascript" };
  const type = baseMime(mime);
  if ((!type || type.startsWith("application/")) && JS_START.test(head)) {
    return { lang: "javascript" };
  }
  return { lang: null };
}

function sniffBodyLang(body, mime) {
  return sniffBody(body, mime).lang;
}

function requestBodyOverrides(entry) {
  return (entry._bodyLang ??= { payload: "auto", response: "auto" });
}

function isBodyTab(tab) {
  return tab === "payload" || tab === "response";
}

function bodySide(entry, tab) {
  const { request, response } = entry._record;
  return tab === "response" ? response : request;
}

// Language for a Payload/Response body: the manual override if set, otherwise auto-detection
// (MIME type, then content). `forced` tells the formatter not to second-guess it. Memoised per
// tab on the body identity, MIME type and override; `json` carries the value the sniffer parsed.
function bodyLanguageFor(entry, tab) {
  const side = bodySide(entry, tab);
  const override = requestBodyOverrides(entry)[tab];
  const memo = (entry._bodyLangMemo ??= {});
  const hit = memo[tab];
  if (
    hit &&
    hit.body === side.body &&
    hit.mime === side.bodyMimeType &&
    hit.override === override
  ) {
    return hit.info;
  }
  let info;
  if (override && override !== "auto") {
    info = { lang: override, forced: true };
  } else {
    try {
      const byMime = langFromContentType(side.bodyMimeType);
      const sniffed = byMime ? { lang: byMime } : sniffBody(side.body, side.bodyMimeType);
      info = { lang: sniffed.lang || "plaintext", forced: false, json: sniffed.json };
    } catch {
      info = { lang: "plaintext", forced: false };
    }
  }
  memo[tab] = { body: side.body, mime: side.bodyMimeType, override, info };
  return info;
}

// One text conversion for anything shown as text: strings as-is, nothing as "", other values as
// pretty JSON (big integers survive).
function valueToText(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : stringifyJsonExact(value, 2);
}

// Pretty-prints a request/response body for the Source view. JSON is detected by content as
// well as MIME type (tRPC/GraphQL clients often send JSON as text/plain); form-encoded bodies
// become one decoded `key=value` per line. Anything that can't be formatted is returned
// unchanged. `forced` (a manual language override) disables content-based guessing.
function formatBodyText(text, lang, mime, forced = false) {
  if (typeof text !== "string" || !text || text.length > FORMAT_BODY_LIMIT) return { text, lang };
  if (forced && lang === "plaintext") return { text, lang };
  const trimmed = text.trim();
  if (lang === "json" || (lang === "plaintext" && /^[[{]/.test(trimmed))) {
    try {
      return { text: formatJsonPayloadText(trimmed), lang: "json" };
    } catch {
      // Not valid JSON or JSON records, fall through.
    }
  }
  if (!forced && /x-www-form-urlencoded/i.test(mime || "")) {
    const decode = (part) => {
      try {
        return decodeURIComponent(part.replace(/\+/g, " "));
      } catch {
        return part;
      }
    };
    return { text: trimmed.split("&").map(decode).join("\n") + "\n", lang: "plaintext" };
  }
  // RSC flight data is line-oriented, not JS statements, so the beautifier would mangle it.
  const flight = /x-component/i.test(mime || "") || looksLikeFlight(trimmed);
  if (lang !== "json" && lang !== "plaintext" && !flight) {
    const pretty = tryPretty(text, lang);
    if (pretty.ok) return { text: pretty.content, lang };
  }
  return { text, lang };
}

// Memoised formatBodyText for a Payload/Response tab: re-renders that only change wrap or the
// viewer don't reformat a large body.
function formattedBodyFor(entry, tab, text, lang, mime, forced) {
  const memo = (entry._formatMemo ??= {});
  const hit = memo[tab];
  if (hit && hit.text === text && hit.lang === lang && hit.mime === mime && hit.forced === forced) {
    return hit.result;
  }
  const result = formatBodyText(text, lang, mime, forced);
  memo[tab] = { text, lang, mime, forced, result };
  return result;
}

function tooLargeToParse(length) {
  const mb = (length / 1_000_000).toFixed(1);
  return { kind: "notice", message: `Too large to parse (${mb} MB). Showing Source is faster.` };
}

// What the Parsed view shows for a body: a JSON value (structured bodies and JSON text), a
// parsed HTML/XML document, or a notice for bodies over the size limit; null when there is
// nothing to parse. `json` is a value the language sniffer already parsed from `body`.
function parseBody(body, lang, json) {
  if (body == null || body === "") return null;
  if (typeof body === "object") {
    return isBase64Body(body) ? null : { kind: "json", value: body };
  }
  if (typeof body !== "string") return null;
  if (lang === "json") {
    if (json !== undefined) return { kind: "json", value: json };
    if (body.length > PARSE_JSON_LIMIT) return tooLargeToParse(body.length);
    const parsed = parseJsonPayload(body);
    return parsed ? { kind: "json", value: parsed.value } : null;
  }
  if (lang === "html" || lang === "xml") {
    if (body.length > PARSE_MARKUP_LIMIT) return tooLargeToParse(body.length);
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

// Parsing is cached per tab until the body or the chosen language changes, so toggle
// visibility checks and re-renders don't re-parse a large body.
function parsedBodyFor(entry, tab) {
  const { body } = bodySide(entry, tab);
  const { lang, json } = bodyLanguageFor(entry, tab);
  const cache = (entry._parsedBody ??= {});
  const hit = cache[tab];
  if (hit && hit.body === body && hit.lang === lang) return hit.result;
  let result;
  try {
    result = parseBody(body, lang, json);
  } catch (error) {
    result = { kind: "notice", message: `Could not build the parsed view: ${error.message}` };
  }
  cache[tab] = { body, lang, result };
  return result;
}

// -- Body view mode: Source, Parsed or Hex --

// Payload and Response keep independent view preferences, keyed by tab, so switching tabs or
// requests never leaks one's state into the other. Choosing a view also records it on the entry
// (`_bodyViewChoice`), which beats the default that binary bodies open in Hex.
function bodyViewPrefs() {
  return (state.requestBodyViewByTab ??= { payload: "source", response: "source" });
}

function setBodyView(entry, tab, view) {
  (entry._bodyViewChoice ??= {})[tab] = view;
  bodyViewPrefs()[tab] = view;
}

// Byte extraction and the current dump page for a tab, kept in one slot per tab (the last body
// shown) so the bytes are not retained for every request ever viewed and re-renders that only
// toggle wrap or format do not re-extract a large body.
const hexBodySlots = { payload: null, response: null };

function hexBodyFor(entry, tab) {
  const isResponse = tab === "response";
  const raw = isResponse ? entry._rawResponseBody : entry._rawRequestBody;
  const explicit = isResponse ? null : entry._requestBodyBytes;
  const encoding = bodySide(entry, tab).bodyEncoding;
  const slot = hexBodySlots[tab];
  if (
    slot &&
    slot.entry === entry &&
    slot.raw === raw &&
    slot.explicit === explicit &&
    slot.encoding === encoding
  ) {
    return slot;
  }
  const result = isResponse ? HexDump.responseBody(entry) : HexDump.requestBody(entry);
  return (hexBodySlots[tab] = {
    entry,
    raw,
    explicit,
    encoding,
    result,
    note: HexDump.describe(result, isResponse ? "response" : "request"),
    page: 0,
    shown: null,
  });
}

// The dump page being shown (clamped to the body), or null when there are no bytes.
function hexPageFor(entry, tab) {
  const slot = hexBodyFor(entry, tab);
  if (slot.result.status !== "bytes") return null;
  if (!slot.shown || slot.shown.page !== slot.page) {
    slot.shown = HexDump.dump(slot.result.bytes, slot.page);
    slot.page = slot.shown.page;
  }
  return slot.shown;
}

function setHexPage(entry, tab, page) {
  hexBodyFor(entry, tab).page = page;
}

// The view a tab actually shows: the entry's own choice, else Hex for binary or undecodable
// bodies, else the tab's preference; falling back to Source when that view has nothing to show.
function bodyViewFor(entry, tab) {
  const { result } = hexBodyFor(entry, tab);
  let want = entry._bodyViewChoice?.[tab];
  if (!want) {
    if (HexDump.prefersHex(result)) want = "hex";
    else {
      want = bodyViewPrefs()[tab];
      if (want === "hex" && result.status !== "bytes") want = "source";
    }
  }
  if (want === "hex" && result.status !== "absent") return "hex";
  if (want === "parsed" && parsedBodyFor(entry, tab)) return "parsed";
  return "source";
}

// The parsed body a tab shows instead of source text: only when Parsed is the shown view.
function shownParsedBody(entry, tab) {
  return bodyViewFor(entry, tab) === "parsed" ? parsedBodyFor(entry, tab) : null;
}
