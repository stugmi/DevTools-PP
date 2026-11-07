// Generates replay code from captured request fields without reading response bodies or doing I/O.
"use strict";

const RequestCode = (() => {
  const FORMATS = Object.freeze([
    { value: "fetch", label: "Browser fetch" },
    { value: "node-fetch", label: "Node.js fetch" },
    { value: "python", label: "Python" },
    { value: "powershell", label: "PowerShell" },
    { value: "curl-bash", label: "cURL (bash)" },
    { value: "curl-cmd", label: "cURL (cmd)" },
  ]);
  const DEFAULT_FORMAT = "fetch";
  // The package the Python format writes for. Both send the captured bytes; httpx can also keep
  // duplicate headers and URL spellings that requests would rewrite.
  const PYTHON_LIBRARIES = Object.freeze([
    { value: "requests", label: "requests" },
    { value: "httpx", label: "httpx" },
  ]);
  const DEFAULT_PYTHON_LIBRARY = "requests";
  // How Python writes JSON text nested in a JSON body: through a stringify(...) function declared
  // above the request, the same helper bound inline by a walrus, or an inline json.dumps(...).
  const PYTHON_NESTED_JSON = Object.freeze([
    { value: "function", label: "Helper function stringify(...)" },
    { value: "walrus", label: "One-line walrus helper stringify := lambda" },
    { value: "inline", label: "Inline json.dumps(...)" },
  ]);
  const DEFAULT_PYTHON_NESTED_JSON = "function";
  const DEFAULT_LINE_WIDTH = 120;
  const MIN_LINE_WIDTH = 40;
  const TRANSPORT_HEADERS = new Set(["content-length", "transfer-encoding"]);
  const BROWSER_HEADERS = new Set([
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "permissions-policy",
    "referer",
    "te",
    "trailer",
    "upgrade",
    "user-agent",
    "via",
  ]);
  // Media types whose bodies are never presented as text, even when the bytes happen to be UTF-8.
  // gRPC-web's text mode (application/grpc-web-text[+proto]) is base64 text, so it is excluded.
  const BINARY_MEDIA =
    /^(?!application\/grpc-web-text(?:\+|$))(?:(?:image|audio|video|font)\/|application\/(?:octet-stream|zip|gzip|x-gzip|x-zip-compressed|zlib|pdf|(?:x-)?protobuf|x-google-protobuf|vnd\.google\.protobuf|grpc(?:-web)?(?:\+proto)?|(?:x-)?msgpack|cbor|wasm|zstd|x-bzip2?|x-tar|x-7z-compressed|vnd\.apache\.avro.*)$|.*\+(?:proto|protobuf|cbor)$)/i;
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const URL_BREAK = /[/?&#]/;
  const TEXT_BREAK = /[\s,;&]/;

  // Line width is a formatting preference: finite numbers of at least 40 are used as given (there
  // is no upper limit), smaller ones become 40, and anything else is the default 120.
  function normalizeLineWidth(value) {
    let width = value;
    if (typeof width === "string" && width.trim() !== "") width = Number(width);
    if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_LINE_WIDTH;
    return Math.max(MIN_LINE_WIDTH, Math.trunc(width));
  }

  // Packs units {s, cost, brk} into chunks of at most `budget` cost (a unit larger than the budget
  // gets its own chunk). When a chunk overflows it is cut after the last unit flagged `brk` if that
  // keeps the chunk at least half full. Concatenating the chunks yields the exact input.
  function splitText(units, budget) {
    const chunks = [];
    let start = 0;
    while (start < units.length) {
      let used = 0;
      let end = start;
      let breakEnd = -1;
      let breakUsed = 0;
      while (end < units.length && (end === start || used + units[end].cost <= budget)) {
        used += units[end].cost;
        end++;
        if (units[end - 1].brk) {
          breakEnd = end;
          breakUsed = used;
        }
      }
      if (end < units.length && breakEnd > start && breakUsed * 2 >= budget) end = breakEnd;
      chunks.push(
        units
          .slice(start, end)
          .map((unit) => unit.s)
          .join("")
      );
      start = end;
    }
    return chunks.length ? chunks : [""];
  }

  // Cuts text on code points; pieces are quoted individually so no escape is ever split.
  function splitChars(text, budget, costOf, breakAfter) {
    return splitText(
      Array.from(String(text), (ch) => ({
        s: ch,
        cost: costOf(ch),
        brk: Boolean(breakAfter) && breakAfter.test(ch),
      })),
      budget
    );
  }

  // Cuts an ASCII string into pieces whose length is a multiple of `unit` characters.
  function splitFixed(text, budget, unit) {
    const size = Math.max(unit, budget - (budget % unit));
    const chunks = [];
    for (let start = 0; start < text.length; start += size)
      chunks.push(text.slice(start, start + size));
    return chunks.length ? chunks : [""];
  }

  function jsString(value) {
    return JSON.stringify(String(value)).replace(
      /[\u007f-\uffff]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
    );
  }

  function hexOf(bytes) {
    const parts = new Array(bytes.length);
    for (let index = 0; index < bytes.length; index++) {
      parts[index] = bytes[index].toString(16).padStart(2, "0");
    }
    return parts.join("");
  }

  function base64(bytes) {
    const chunks = [];
    for (let start = 0; start < bytes.length; start += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
    }
    return btoa(chunks.join(""));
  }

  function fromBase64(text) {
    try {
      return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
    } catch {
      throw new Error("Cannot copy request: the captured base64 body is invalid.");
    }
  }

  function shellString(value) {
    const text = String(value);
    if (/^[\x20-\x7e]*$/.test(text)) return "'" + text.replace(/'/g, "'\"'\"'") + "'";
    return (
      "$'" +
      Array.from(
        new TextEncoder().encode(text),
        (byte) => "\\x" + byte.toString(16).padStart(2, "0")
      ).join("") +
      "'"
    );
  }

  function psString(value) {
    const text = String(value);
    if (/^[\x20-\x7e]*$/.test(text)) return "'" + text.replace(/'/g, "''") + "'";
    return (
      "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      base64(new TextEncoder().encode(text)) +
      "')))"
    );
  }

  const psCost = (ch) => (/^[\x20-\x7e]$/.test(ch) ? (ch === "'" ? 2 : 1) : 60);
  const shellCost = (ch) => Math.max(1, shellString(ch).length - 2);

  // -- Capture normalization --

  function mediaType(value) {
    return /^\s*([^;\s]*)/.exec(value || "")[1].toLowerCase();
  }

  function charsetOf(value) {
    return /charset\s*=\s*["']?([^\s;"']+)/i.exec(value || "")?.[1];
  }

  function headerValue(headers, name) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  }

  function isEncodedContent(headers) {
    return headers.some(
      ([name, value]) =>
        name.toLowerCase() === "content-encoding" &&
        value.split(",").some((token) => {
          const coding = token.trim().toLowerCase();
          return coding !== "" && coding !== "identity";
        })
    );
  }

  function isBinaryMedia(contentType) {
    return BINARY_MEDIA.test(mediaType(contentType));
  }

  // Control characters other than tab and line breaks: the text is really binary data.
  function hasBinaryControl(text) {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x7f || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) return true;
    }
    return false;
  }

  // Exact bytes always win; `text` is only set when the bytes are safely presentable UTF-8 text.
  function bodyShape(bytes, contentType, encoded) {
    let text = null;
    const charset = charsetOf(contentType);
    if (
      !encoded &&
      !isBinaryMedia(contentType) &&
      (!charset || /^(utf-?8|us-ascii)$/i.test(charset))
    ) {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    return { bytes, text };
  }

  function bodyFor(entry, request, headers) {
    const postData = entry._requestPostData;
    const contentType = headerValue(headers, "content-type") ?? request.bodyMimeType ?? "";
    const encoded = isEncodedContent(headers);
    const explicit = entry._requestBodyBytes;
    if (explicit && typeof explicit.base64 === "string") {
      return bodyShape(fromBase64(explicit.base64), contentType, encoded);
    }
    const text = entry._rawRequestBody;
    const encoding = request.bodyEncoding || postData?.encoding;
    if (encoding && encoding !== "base64") {
      throw new Error("Cannot copy request: unsupported captured body encoding " + encoding + ".");
    }
    if (text != null) {
      if (encoding === "base64") return bodyShape(fromBase64(text), contentType, encoded);
      const charset = charsetOf(contentType);
      if (charset && !/^(utf-?8|us-ascii)$/i.test(charset)) {
        throw new Error(
          "Cannot copy request byte-for-byte: raw " + charset + " body bytes are unavailable."
        );
      }
      if (encoded) {
        throw new Error(
          "Cannot copy request byte-for-byte: the Content-Encoding body bytes were not captured."
        );
      }
      if (text.includes("\ufffd") || LONE_SURROGATE.test(text)) {
        throw new Error(
          "Cannot copy request byte-for-byte: the captured body text contains replacement or " +
            "unpaired surrogate characters, so the original bytes were not captured."
        );
      }
      return bodyShape(new TextEncoder().encode(text), contentType, false);
    }
    if (postData?.params?.length) {
      if (
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
          postData.mimeType || request.bodyMimeType || ""
        )
      ) {
        throw new Error(
          "Cannot copy request: the raw multipart or file-upload body was not captured."
        );
      }
      const form = new URLSearchParams();
      const params = [];
      for (const param of postData.params) {
        if (param.fileName != null || param.value == null) {
          throw new Error("Cannot copy request: an uploaded file's bytes were not captured.");
        }
        if (LONE_SURROGATE.test(param.name) || LONE_SURROGATE.test(param.value)) {
          throw new Error("Cannot copy request: form parameters contain unpaired surrogates.");
        }
        form.append(param.name, param.value);
        params.push([String(param.name), String(param.value)]);
      }
      const formText = form.toString();
      // Only parsed parameters were captured: renderers may rebuild an equivalent form.
      return {
        bytes: new TextEncoder().encode(formText),
        text: formText,
        structured: true,
        params,
      };
    }
    if (
      request.bodySize > 0 ||
      Object.hasOwn(request, "body") ||
      (postData && request.bodySize !== 0)
    ) {
      throw new Error("Cannot copy request: the original request body was not captured.");
    }
    return null;
  }

  function replayHeaders(request) {
    const headers = (request.headers || [])
      .filter(
        ({ name }) => name && !name.startsWith(":") && !TRANSPORT_HEADERS.has(name.toLowerCase())
      )
      .map(({ name, value }) => [String(name), String(value)]);
    if (request.cookies?.length && !headers.some(([name]) => name.toLowerCase() === "cookie")) {
      headers.push([
        "Cookie",
        request.cookies.map(({ name, value }) => name + "=" + value).join("; "),
      ]);
    }
    return headers;
  }

  // Exact request body without URL, method or format checks: null when absent, otherwise
  // {bytes, text|null, structured?, params?}. Throws "Cannot copy request..." when the original
  // bytes are unavailable or unsafe. Display copies (`request.body`) are never read as raw bytes.
  function requestBody(entry) {
    const request = entry?._record?.request;
    return request ? bodyFor(entry, request, replayHeaders(request)) : null;
  }

  function normalize(entry) {
    const request = entry?._record?.request;
    if (!request || !/^https?:\/\//i.test(request.url || "")) {
      throw new Error("Copy as requires a captured HTTP or HTTPS request.");
    }
    const headers = replayHeaders(request);
    const body = bodyFor(entry, request, headers);
    if (
      body &&
      request.bodyMimeType &&
      !headers.some(([name]) => name.toLowerCase() === "content-type")
    ) {
      headers.push(["Content-Type", request.bodyMimeType]);
    }
    return { url: request.url, method: request.method || "GET", headers, body };
  }

  function duplicateHeader(headers) {
    const seen = new Set();
    for (const [name] of headers) {
      const key = name.toLowerCase();
      if (seen.has(key)) return name;
      seen.add(key);
    }
    return null;
  }

  function requireBodySupport(request, format) {
    if (request.body?.bytes.length && /^(GET|HEAD)$/i.test(request.method)) {
      throw new Error(format + " cannot replay a " + request.method + " request with a body.");
    }
  }

  // -- JavaScript --

  // `head` is text before the value (e.g. "const url = "); `tail` follows it. One line when it
  // fits, otherwise the value is split into "a" + "b" pieces on following lines. `quote` turns
  // text into a string literal.
  function jsValueLines(pad, head, text, width, tail, breakAfter, quote = jsString) {
    const whole = quote(text);
    if ((pad + head + whole + tail).length <= width) return [pad + head + whole + tail];
    const lines = head.trim() ? [pad + head.trimEnd()] : [];
    const inner = head.trim() ? pad + "  " : pad;
    const cost = (ch) => Math.max(1, quote(ch).length - 2);
    const pieces = splitChars(text, Math.max(12, width - inner.length - 4), cost, breakAfter).map(
      quote
    );
    pieces.forEach((piece, index) => {
      lines.push(inner + piece + (index < pieces.length - 1 ? " +" : tail));
    });
    return lines;
  }

  // Literal quoting for JSON payload strings: single quotes when the text has more double quotes
  // than single quotes, so embedded JSON text needs fewer escapes.
  function jsQuoter(text) {
    let doubles = 0;
    let singles = 0;
    for (const ch of text) {
      if (ch === '"') doubles++;
      else if (ch === "'") singles++;
    }
    if (singles >= doubles) return jsString;
    return (value) =>
      "'" +
      jsString(value)
        .slice(1, -1)
        .replace(/\\[\s\S]|'/g, (token) =>
          token === '\\"' ? '"' : token === "'" ? "\\'" : token
        ) +
      "'";
  }

  // Header pairs stay on one line, however long, so each header reads as a unit.
  function jsPairLines(pad, name, value) {
    return [pad + "[" + jsString(name) + ", " + jsString(value) + "],"];
  }

  // Parsed JSON object or array when JSON.stringify of the equivalent literal reproduces `text`
  // exactly: compact separators, literal non-ASCII, and numbers JavaScript prints the same way.
  // A "__proto__" key would set the literal's prototype instead of a property, so it falls back.
  // String values that are themselves such JSON become nested JSON.stringify(...) nodes.
  function jsPayload(text) {
    const tree = text ? parseJson(text) : null;
    if (tree?.t !== "obj" && tree?.t !== "arr") return null;
    const exact = (node, source) => {
      const walk = (item) => {
        if (item.t === "num") return String(Number(item.lex)) === item.lex;
        if (item.t === "arr") return item.items.every(walk);
        if (item.t === "obj") {
          return item.items.every(([key, value]) => key !== "__proto__" && walk(value));
        }
        return true;
      };
      return walk(node) && dumpJson(node, true, false) === source;
    };
    return exact(tree, text) ? nestJson(tree, exact) : null;
  }

  const jsKey = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : jsString(key));

  function jsInline(node) {
    switch (node.t) {
      case "obj":
        return node.items.length
          ? "{ " +
              node.items.map(([key, item]) => jsKey(key) + ": " + jsInline(item)).join(", ") +
              " }"
          : "{}";
      case "arr":
        return "[" + node.items.map(jsInline).join(", ") + "]";
      case "str":
        return jsQuoter(node.v)(node.v);
      case "nest":
        return "JSON.stringify(" + jsInline(node.tree) + ")";
      case "num":
        return node.lex;
      default:
        return node.t;
    }
  }

  // Lays out a parsed JSON value as a JavaScript literal: one line when it fits, otherwise one
  // member per line, indented two spaces per level. String values are never split.
  function jsLiteralLines(node, pad, head, tail, width) {
    const one = jsInline(node);
    if ((pad + head + one + tail).length <= width) return [pad + head + one + tail];
    if (node.t === "nest") {
      return jsLiteralLines(node.tree, pad, head + "JSON.stringify(", ")" + tail, width);
    }
    // Strings stay whole, however long, so each value reads as a unit.
    if (node.t === "str") return [pad + head + one + tail];
    if (node.t !== "obj" && node.t !== "arr") return [pad + head + one + tail];
    const object = node.t === "obj";
    const inner = pad + "  ";
    const lines = [pad + head + (object ? "{" : "[")];
    for (const item of node.items) {
      lines.push(
        ...(object
          ? jsLiteralLines(item[1], inner, jsKey(item[0]) + ": ", ",", width)
          : jsLiteralLines(item, inner, "", ",", width))
      );
    }
    lines.push(pad + (object ? "}" : "]") + tail);
    return lines;
  }

  function javascript(request, browser, width, name) {
    requireBodySupport(request, browser ? "Browser fetch" : "Node.js fetch");
    const headers = browser
      ? request.headers.filter(([name]) => {
          const key = name.toLowerCase();
          return !BROWSER_HEADERS.has(key) && !/^(proxy-|sec-)/.test(key);
        })
      : request.headers;
    const notes = [];
    const duplicate = duplicateHeader(headers);
    if (browser && headers.length !== request.headers.length) {
      notes.push(
        "// Browser-managed headers, including cookies, come from the current browser session."
      );
    }
    if (duplicate !== null) {
      notes.push(
        '// Duplicate header names are listed separately; fetch combines them with ", " when sent.'
      );
    }
    const inlineHead = "const " + name + " = await fetch(" + jsString(request.url) + ", {";
    const inlineUrl = inlineHead.length <= width;
    const lines = [];
    if (inlineUrl) lines.push(inlineHead);
    else {
      lines.push(
        "const " + name + " = await fetch(",
        ...jsValueLines("  ", "", request.url, width, ",", URL_BREAK),
        "  {"
      );
    }
    // Options sit two spaces inside the opening brace; the long-URL form nests one level deeper.
    const base = inlineUrl ? "  " : "    ";
    const deeper = base + "  ";
    const bodyPad = base + "    ";
    lines.push(base + "method: " + jsString(request.method) + ",");
    if (headers.length) {
      // Pairs keep duplicates, and names an object literal would reorder or treat specially.
      const pairs =
        duplicate !== null ||
        headers.some(([hname]) => hname === "__proto__" || /^(?:0|[1-9]\d*)$/.test(hname));
      lines.push(base + (pairs ? "headers: [" : "headers: {"));
      for (const [hname, value] of headers) {
        lines.push(
          ...(pairs
            ? jsPairLines(deeper, hname, value)
            : [deeper + jsString(hname) + ": " + jsString(value) + ","])
        );
      }
      lines.push(base + (pairs ? "]," : "},"));
    }
    if (browser) lines.push(base + 'credentials: "include",');
    if (request.body && !/^(GET|HEAD)$/i.test(request.method)) {
      const payload = jsPayload(request.body.text);
      if (payload) {
        const payloadName = name.replace("response", "payload");
        notes.push(...jsLiteralLines(payload, "", "const " + payloadName + " = ", ";", width));
        lines.push(base + "body: JSON.stringify(" + payloadName + "),");
      } else if (request.body.text != null) {
        lines.push(...jsValueLines(base, "body: ", request.body.text, width, ",", TEXT_BREAK));
      } else {
        const pieces = splitFixed(
          base64(request.body.bytes),
          Math.max(8, width - bodyPad.length - 4),
          4
        ).map(jsString);
        const wrap = (pad, tail) =>
          pieces.map((piece, index) => pad + piece + (index < pieces.length - 1 ? " +" : tail));
        if (browser) {
          const one =
            base + "body: Uint8Array.from(atob(" + pieces[0] + "), (c) => c.charCodeAt(0)),";
          if (pieces.length === 1 && one.length <= width) lines.push(one);
          else {
            lines.push(base + "body: Uint8Array.from(", deeper + "atob(");
            lines.push(...wrap(deeper + "  ", ""));
            lines.push(deeper + "),", deeper + "(c) => c.charCodeAt(0),", base + "),");
          }
        } else {
          const one = base + "body: Buffer.from(" + pieces[0] + ', "base64"),';
          if (pieces.length === 1 && one.length <= width) lines.push(one);
          else {
            lines.push(base + "body: Buffer.from(");
            lines.push(...wrap(deeper, ","));
            lines.push(deeper + '"base64",', base + "),");
          }
        }
      }
    }
    lines.push(inlineUrl ? "});" : "  },", ...(inlineUrl ? [] : [");"]));
    return notes.concat(lines).join("\n");
  }

  // -- Python --
  // Output never imports anything; the caller supplies `requests` or `httpx`, plus `json` for
  // JSON text bodies. Code is laid out from a small node tree: s (string), b (bytes), r (raw token),
  // d (dict; `inline` lets a JSON dict share a line), l (list/tuple), c (call; a null keyword is a
  // positional argument, `inline` lets several arguments share a line, `after` follows the ")",
  // `hug` wraps the first argument's brackets), w (JSON value sent through the walrus helper).

  function pyToken(ch, quote) {
    if (ch === "\\") return "\\\\";
    if (ch === quote) return "\\" + quote;
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    const point = ch.codePointAt(0);
    if (point < 0x20 || (point >= 0x7f && point < 0xa0)) {
      return "\\x" + point.toString(16).padStart(2, "0");
    }
    if (point >= 0xa0 && /[\p{C}\p{Z}]/u.test(ch)) {
      return point > 0xffff
        ? "\\U" + point.toString(16).padStart(8, "0")
        : "\\u" + point.toString(16).padStart(4, "0");
    }
    return ch;
  }

  // Double quotes unless single quotes need fewer escapes.
  function pyQuote(text) {
    let doubles = 0;
    let singles = 0;
    for (const ch of text) {
      if (ch === '"') doubles++;
      else if (ch === "'") singles++;
    }
    return singles < doubles ? "'" : '"';
  }

  function pyUnits(node, quote) {
    return Array.from(node.text, (ch) => {
      const s = pyToken(ch, quote);
      return { s, cost: s.length, brk: Boolean(node.brk) && node.brk.test(ch) };
    });
  }

  const pyStr = (text, brk) => ({ t: "s", text: String(text), brk });
  // A string that is never split across lines, however long (header names and values).
  const pyWhole = (text) => ({ t: "s", text: String(text), whole: true });
  const pyRaw = (code) => ({ t: "r", code });

  function pyInline(node) {
    switch (node.t) {
      case "s": {
        const quote = pyQuote(node.text);
        const body = pyUnits(node, quote)
          .map((unit) => unit.s)
          .join("");
        return quote + body + quote + (node.enc ? '.encode("utf-8")' : "");
      }
      case "b":
        return node.bytes.length ? 'bytes.fromhex("' + hexOf(node.bytes) + '")' : 'b""';
      case "r":
        return node.code;
      case "d": {
        if (!node.inline || !node.items.length) return node.items.length ? null : "{}";
        const parts = node.items.map(([key, value]) => [pyInline(key), pyInline(value)]);
        if (parts.flat().includes(null)) return null;
        return "{" + parts.map(([key, value]) => key + ": " + value).join(", ") + "}";
      }
      case "l": {
        if (node.multi && node.items.length) return null;
        const parts = node.items.map(pyInline);
        if (parts.includes(null)) return null;
        return node.open + parts.join(", ") + node.close;
      }
      case "w":
        return (
          "(" +
          PY_STRINGIFY +
          " := lambda v: " +
          pyInline(PY_WALRUS_DUMPS) +
          ")(" +
          pyInline(node.value) +
          ")" +
          (node.after || "")
        );
      case "c": {
        if (node.args.length > 1 && !node.inline) return null;
        const parts = node.args.map(([keyword, value]) => {
          const text = pyInline(value);
          return text === null || keyword === null ? text : keyword + "=" + text;
        });
        if (parts.includes(null)) return null;
        return node.name + "(" + parts.join(", ") + ")" + (node.after || "");
      }
      default:
        throw new Error("Unknown Python node " + node.t);
    }
  }

  // Lays a node out on lines: one line when it fits, otherwise wrapped by node type.
  function pyRender(node, indent, prefix, suffix, width) {
    const pad = " ".repeat(indent);
    const one = pyInline(node);
    if (one !== null && pad.length + prefix.length + one.length + suffix.length <= width) {
      return [pad + prefix + one + suffix];
    }
    const inner = indent + 4;
    const innerPad = " ".repeat(inner);
    const budget = Math.max(12, width - inner - 2);
    switch (node.t) {
      case "s": {
        if (node.whole) return [pad + prefix + pyInline(node) + suffix];
        const quote = pyQuote(node.text);
        const pieces = splitText(pyUnits(node, quote), budget);
        return [
          pad + prefix + "(",
          ...pieces.map((piece) => innerPad + quote + piece + quote),
          pad + ")" + (node.enc ? '.encode("utf-8")' : "") + suffix,
        ];
      }
      case "b": {
        const pieces = splitFixed(hexOf(node.bytes), budget, 2);
        return [
          pad + prefix + "bytes.fromhex(",
          ...pieces.map((piece) => innerPad + '"' + piece + '"'),
          pad + ")" + suffix,
        ];
      }
      case "d": {
        const lines = [pad + prefix + "{"];
        for (const [key, value] of node.items) {
          const keyText = pyInline(key);
          const keyLines = pyRender(key, inner, "", "", width);
          if (innerPad.length + keyText.length + 3 <= width || keyLines.length === 1) {
            lines.push(...pyRender(value, inner, keyText + ": ", ",", width));
            continue;
          }
          // A key too long for one line becomes a parenthesized run of adjacent literals.
          const valueLines = pyRender(value, inner, "", ",", width);
          keyLines[keyLines.length - 1] += ": " + valueLines[0].slice(inner);
          lines.push(...keyLines, ...valueLines.slice(1));
        }
        lines.push(pad + "}" + suffix);
        return lines;
      }
      case "l": {
        const lines = [pad + prefix + node.open];
        for (const item of node.items) lines.push(...pyRender(item, inner, "", ",", width));
        lines.push(pad + node.close + suffix);
        return lines;
      }
      case "c": {
        // A hugging call wraps its first argument's brackets, json.dumps([ ... ], k=v), when the
        // first and last lines fit; otherwise each argument gets its own line.
        if (node.hug) {
          const rest = node.args
            .slice(1)
            .map(([keyword, value]) => ", " + keyword + "=" + pyInline(value))
            .join("");
          const close = rest + ")" + (node.after || "") + suffix;
          const lines = pyRender(node.args[0][1], indent, prefix + node.name + "(", close, width);
          if (lines[0].length <= width && lines[lines.length - 1].length <= width) return lines;
        }
        const lines = [pad + prefix + node.name + "("];
        for (const [keyword, value] of node.args) {
          lines.push(...pyRender(value, inner, keyword === null ? "" : keyword + "=", ",", width));
        }
        lines.push(pad + ")" + (node.after || "") + suffix);
        return lines;
      }
      case "w": {
        // (stringify := lambda v: json.dumps(v, ...))({ ... }): the walrus binds stringify before
        // the argument, which may call stringify(...), is evaluated.
        const close = ")" + (node.after || "") + suffix;
        const binding = PY_STRINGIFY + " := lambda v: ";
        const head = "(" + binding + pyInline(PY_WALRUS_DUMPS) + ")(";
        const lines = pyRender(node.value, indent, prefix + head, close, width);
        if (lines[0].length <= width) return lines;
        return [
          pad + prefix + "(",
          ...pyRender(PY_WALRUS_DUMPS, inner, binding, "", width),
          ...pyRender(node.value, indent, ")(", close, width),
        ];
      }
      default:
        return [pad + prefix + one + suffix];
    }
  }

  // Parses JSON natively, keeping number lexemes through the reviver's `context.source`. Returns
  // null when the value cannot be mirrored by a Python literal, or when the engine does not expose
  // source text. Duplicate or reordered keys show up as a mismatch against the original in dumpJson.
  function parseJson(text) {
    const reject = new Error("unsupported JSON");
    try {
      return JSON.parse(text, (key, value, context) => {
        if (value !== null && typeof value === "object") {
          const array = Array.isArray(value);
          const items = array ? value : Object.entries(value);
          let depth = 1;
          for (const item of items) depth = Math.max(depth, 1 + (array ? item : item[1]).depth);
          if (depth > 40) throw reject;
          if (!array && items.some(([name]) => LONE_SURROGATE.test(name))) throw reject;
          return { t: array ? "arr" : "obj", items, depth };
        }
        if (typeof value === "string") {
          if (LONE_SURROGATE.test(value)) throw reject;
          return { t: "str", v: value, depth: 0 };
        }
        if (typeof value === "number") {
          if (typeof context?.source !== "string" || !exactNumber(context.source)) throw reject;
          return { t: "num", lex: context.source, depth: 0 };
        }
        return { t: String(value), depth: 0 };
      });
    } catch {
      return null;
    }
  }

  // True when Python's int/float repr and json.dumps print this exact lexeme. Floats print as the
  // shortest digits that round-trip (the same digits JavaScript's Number#toString picks), without
  // an exponent between 1e-4 and 1e16, and whole floats keep a ".0".
  function exactNumber(lexeme) {
    if (/^-?(?:0|[1-9]\d*)$/.test(lexeme)) return lexeme !== "-0" && lexeme.length <= 64;
    if (!/^-?(?:0|[1-9]\d*)\.\d+$/.test(lexeme)) return false;
    const value = Number(lexeme);
    if (value === 0) return /^-?0\.0$/.test(lexeme);
    const size = Math.abs(value);
    if (size < 1e-4 || size >= 1e16) return false;
    const shortest = String(value);
    return lexeme === (shortest.includes(".") ? shortest : shortest + ".0");
  }

  // json.dumps output for the parsed value with default (", ", ": ") or compact (",", ":")
  // separators, escaping non-ASCII characters when `ascii` is set. requests' json= uses the
  // defaults; httpx 0.28+ json= and JavaScript's JSON.stringify are compact and keep non-ASCII.
  function dumpJson(node, compact, ascii) {
    const sep = compact ? [",", ":"] : [", ", ": "];
    switch (node.t) {
      case "obj":
        return (
          "{" +
          node.items
            .map(
              ([key, item]) => dumpJsonString(key, ascii) + sep[1] + dumpJson(item, compact, ascii)
            )
            .join(sep[0]) +
          "}"
        );
      case "arr":
        return "[" + node.items.map((item) => dumpJson(item, compact, ascii)).join(sep[0]) + "]";
      case "str":
        return dumpJsonString(node.v, ascii);
      case "num":
        return node.lex;
      default:
        return node.t;
    }
  }

  function dumpJsonString(value, ascii) {
    const named = {
      '"': '\\"',
      "\\": "\\\\",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      "\b": "\\b",
      "\f": "\\f",
    };
    let out = '"';
    for (let index = 0; index < value.length; index++) {
      const ch = value[index];
      const code = value.charCodeAt(index);
      if (named[ch]) out += named[ch];
      else if (code < 0x20 || (ascii && code > 0x7e)) {
        out += "\\u" + code.toString(16).padStart(4, "0");
      } else out += ch;
    }
    return out + '"';
  }

  // Copy of a parsed JSON tree in which each string holding JSON text (starting with "{", "[" or
  // a double quote) that `accept(tree, text)` re-serializes exactly becomes {t: "nest", tree},
  // recursively. Other strings, including bare scalars such as "false" or "5651832", stay text.
  function nestJson(node, accept) {
    switch (node.t) {
      case "obj":
        return { ...node, items: node.items.map(([key, item]) => [key, nestJson(item, accept)]) };
      case "arr":
        return { ...node, items: node.items.map((item) => nestJson(item, accept)) };
      case "str": {
        if (!/^[[{"]/.test(node.v)) return node;
        const tree = parseJson(node.v);
        return /^(?:obj|arr|str)$/.test(tree?.t) && accept(tree, node.v)
          ? { t: "nest", tree: nestJson(tree, accept) }
          : node;
      }
      default:
        return node;
    }
  }

  function hasNest(node) {
    if (node.t === "nest") return true;
    if (node.t === "arr") return node.items.some(hasNest);
    return node.t === "obj" && node.items.some(([, item]) => hasNest(item));
  }

  // `helper` names the function that writes nested JSON text (stringify, declared above the
  // request or bound by the walrus); without it each nested value gets its own json.dumps(...).
  function jsonToPy(node, helper) {
    const convert = (item) => jsonToPy(item, helper);
    switch (node.t) {
      case "obj":
        return {
          t: "d",
          inline: true,
          items: node.items.map(([key, item]) => [pyWhole(key), convert(item)]),
        };
      case "arr":
        return { t: "l", open: "[", close: "]", items: node.items.map(convert) };
      case "str":
        return pyWhole(node.v);
      case "nest":
        return helper
          ? { t: "c", name: helper, hug: true, args: [[null, convert(node.tree)]] }
          : pyDumpsCall(convert(node.tree), true, false);
      case "num":
        return pyRaw(node.lex);
      case "true":
        return pyRaw("True");
      case "false":
        return pyRaw("False");
      default:
        return pyRaw("None");
    }
  }

  // Percent-encoding exactly as urllib.parse.urlencode / quote_plus (UTF-8, space as "+").
  function pyFormEncode(value) {
    let out = "";
    for (const byte of new TextEncoder().encode(value)) {
      if (byte === 0x20) out += "+";
      else if (/[A-Za-z0-9_.~-]/.test(String.fromCharCode(byte))) out += String.fromCharCode(byte);
      else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
    return out;
  }

  function parseForm(text) {
    if (!text) return null;
    const pairs = [];
    for (const part of text.split("&")) {
      const at = part.indexOf("=");
      if (at < 0) return null;
      try {
        pairs.push([
          decodeURIComponent(part.slice(0, at).replace(/\+/g, " ")),
          decodeURIComponent(part.slice(at + 1).replace(/\+/g, " ")),
        ]);
      } catch {
        return null;
      }
    }
    return pairs
      .map(([name, value]) => pyFormEncode(name) + "=" + pyFormEncode(value))
      .join("&") === text
      ? pairs
      : null;
  }

  // Form fields as a Python mapping or tuple list that the target library encodes identically.
  function formToPy(pairs, httpx) {
    const names = pairs.map(([name]) => name);
    if (new Set(names).size === names.length) {
      return {
        t: "d",
        items: pairs.map(([name, value]) => [pyWhole(name), pyWhole(value)]),
      };
    }
    if (!httpx) {
      return {
        t: "l",
        open: "[",
        close: "]",
        multi: true,
        items: pairs.map(([name, value]) => ({
          t: "l",
          open: "(",
          close: ")",
          items: [pyWhole(name), pyWhole(value)],
        })),
      };
    }
    // httpx only takes mappings: repeated names must be adjacent to keep the order.
    const groups = [];
    for (const [name, value] of pairs) {
      const last = groups[groups.length - 1];
      if (last?.name === name) last.values.push(value);
      else if (groups.some((group) => group.name === name)) return null;
      else groups.push({ name, values: [value] });
    }
    return {
      t: "d",
      items: groups.map(({ name, values }) => [
        pyWhole(name),
        values.length === 1
          ? pyWhole(values[0])
          : {
              t: "l",
              open: "[",
              close: "]",
              items: values.map((value) => pyWhole(value)),
            },
      ]),
    };
  }

  // json.dumps spelling that rebuilds `text` from its parsed tree, or null when none matches.
  // Compact separators and literal non-ASCII (what browsers send) are tried first.
  function pyDumpsSpelling(tree, text) {
    for (const compact of [true, false]) {
      for (const ascii of [false, true]) {
        if (dumpJson(tree, compact, ascii) === text) return { compact, ascii };
      }
    }
    return null;
  }

  // json.dumps(value, ...) hugging the value's brackets when the closing line fits.
  function pyDumpsCall(value, compact, ascii) {
    const args = [[null, value]];
    if (compact) args.push(["separators", pyRaw('(",", ":")')]);
    if (!ascii) args.push(["ensure_ascii", pyRaw("False")]);
    return { t: "c", name: "json.dumps", inline: true, hug: true, args };
  }

  // The helpers' body: compact separators and literal non-ASCII, as JSON.stringify writes.
  const PY_WALRUS_DUMPS = pyDumpsCall(pyRaw("v"), true, false);
  const PY_STRINGIFY = "stringify";

  // The declared helper, laid out at the line width like the rest of the snippet.
  function pyStringifyDef(width) {
    const dumps = pyDumpsCall(pyRaw("value"), true, false);
    return ["def " + PY_STRINGIFY + "(value):", ...pyRender(dumps, 4, "return ", "", width)].join(
      "\n"
    );
  }

  // Chooses the Python body argument. Forms and JSON replace the raw body only when the library
  // (or json.dumps) reproduces the captured bytes exactly, or when the only capture is structured
  // parameters. JSON objects and arrays are written as Python literals; string values holding
  // exact compact JSON become stringify(...) calls (declared helper or walrus-bound one) or
  // json.dumps(...) calls, per `nestedJson`. Only real JSON content types use json=; others send
  // json.dumps text so the captured Content-Type stays.
  function pyBody(request, httpx, nestedJson) {
    const body = request.body;
    if (!body) return null;
    const rawKeyword = httpx ? "content" : "data";
    const contentType = headerValue(request.headers, "content-type");
    const media = mediaType(contentType);
    if (body.structured) {
      const node = formToPy(body.params, httpx);
      if (node) return ["data", node];
    }
    const text = body.text;
    // Multipart keeps its exact bytes even when they are plain ASCII. Control characters other than
    // tab and line breaks also mean binary data.
    if (text == null || media.startsWith("multipart/") || hasBinaryControl(text)) {
      return [rawKeyword, { t: "b", bytes: body.bytes }];
    }
    // Pass non-ASCII UTF-8 text as bytes so requests computes its byte length.
    const after = !httpx && body.bytes.length !== text.length ? '.encode("utf-8")' : "";
    const tree = text ? parseJson(text) : null;
    const container = tree?.t === "obj" || tree?.t === "arr";
    const nestedTree = container
      ? nestJson(tree, (sub, source) => dumpJson(sub, true, false) === source)
      : tree;
    // The walrus helper also serializes the outer value, so the body must use its spelling.
    const compactOuter = container && hasNest(nestedTree) && dumpJson(tree, true, false) === text;
    if (nestedJson === "walrus" && compactOuter) {
      return [rawKeyword, { t: "w", value: jsonToPy(nestedTree, PY_STRINGIFY), after }];
    }
    // The declared helper serializes nested values, and the outer one too when it uses its spelling.
    const nestedName = nestedJson === "function" ? PY_STRINGIFY : null;
    if (nestedName && compactOuter) {
      const value = jsonToPy(nestedTree, nestedName);
      return [rawKeyword, { t: "c", name: nestedName, hug: true, args: [[null, value]], after }];
    }
    const charset = charsetOf(contentType);
    if (
      tree &&
      tree.t !== "null" &&
      contentType != null &&
      /^(?:application|text)\/(?:json|[\w.+-]+\+json)$/.test(media) &&
      (!charset || /^utf-?8$/i.test(charset)) &&
      dumpJson(tree, httpx, !httpx) === text
    ) {
      return ["json", jsonToPy(nestedTree, nestedName)];
    }
    const spelling = container ? pyDumpsSpelling(tree, text) : null;
    if (spelling) {
      const call = pyDumpsCall(jsonToPy(nestedTree, nestedName), spelling.compact, spelling.ascii);
      call.after = after;
      return [rawKeyword, call];
    }
    if (media === "application/x-www-form-urlencoded") {
      const pairs = parseForm(text);
      const node = pairs && formToPy(pairs, httpx);
      if (node) return ["data", node];
    }
    return [rawKeyword, { t: "s", text, brk: TEXT_BREAK, enc: Boolean(after) }];
  }

  function pyHeaders(headers, httpx) {
    if (!headers.length) return null;
    const duplicate = duplicateHeader(headers);
    if (duplicate !== null && !httpx) {
      throw new Error(
        'Python requests cannot send duplicate header "' +
          duplicate +
          '" without merging it; set the Python library to httpx in Settings or choose another Copy as format.'
      );
    }
    if (duplicate !== null) {
      return {
        t: "l",
        open: "[",
        close: "]",
        multi: true,
        items: headers.map(([name, value]) => ({
          t: "l",
          open: "(",
          close: ")",
          items: [pyWhole(name), pyWhole(value)],
        })),
      };
    }
    return {
      t: "d",
      items: headers.map(([name, value]) => [pyWhole(name), pyWhole(value)]),
    };
  }

  // requests re-quotes the URL: it uppercases escape hex, decodes escaped unreserved characters
  // and rewrites malformed escapes. httpx keeps the target as written.
  function requireExactRequestsUrl(url) {
    const unsafe = /%(?![0-9A-Fa-f]{2})|%([0-9A-Fa-f]{2})/g;
    for (const match of url.matchAll(unsafe)) {
      const hex = match[1];
      const byte = hex === undefined ? -1 : parseInt(hex, 16);
      const unreserved =
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        byte === 0x2d ||
        byte === 0x2e ||
        byte === 0x5f ||
        byte === 0x7e;
      if (hex === undefined || /[a-f]/.test(hex) || unreserved) {
        throw new Error(
          "Requests normalizes this URL; set the Python library to httpx in Settings, or choose cURL, to preserve the exact request target."
        );
      }
    }
  }

  function python(request, httpx, width, nestedJson) {
    if (!httpx) requireExactRequestsUrl(request.url);
    const helper = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method)
      ? request.method.toLowerCase()
      : null;
    const body = pyBody(request, httpx, nestedJson);
    // httpx's GET, DELETE, HEAD and OPTIONS helpers take no request body arguments.
    const useHelper =
      helper !== null && !(httpx && body && /^(?:GET|DELETE|HEAD|OPTIONS)$/.test(request.method));
    const args = [];
    if (!useHelper) args.push(["method", pyStr(request.method)]);
    args.push(["url", pyStr(request.url, URL_BREAK)]);
    const headers = pyHeaders(request.headers, httpx);
    if (headers) args.push(["headers", headers]);
    if (body) args.push(body);
    const name = (httpx ? "httpx." : "requests.") + (useHelper ? helper : "request");
    const call = pyRender({ t: "c", name, args }, 0, "response = ", "", width).join("\n");
    // The declared stringify helper goes once above the request(s) that call it (see serialize).
    // The walrus mode binds the same name inline, so it needs no declaration.
    const declares = nestedJson === "function" && body && pyCalls(body[1], PY_STRINGIFY);
    return declares ? { call, stringify: true } : { call };
  }

  // Whether a Python node tree calls the function `name` anywhere.
  function pyCalls(node, name) {
    if (!node || typeof node !== "object") return false;
    if (node.t === "c" && node.name === name) return true;
    const children = [node.value, ...(node.items || []), ...(node.args || [])];
    return children.some((child) =>
      Array.isArray(child) ? child.some((part) => pyCalls(part, name)) : pyCalls(child, name)
    );
  }

  // -- PowerShell --

  // Single-quoted PS literal (or encoded-UTF8 expression) split into 'a' + 'b' pieces.
  function psValueLines(pad, head, text, width, breakAfter) {
    const whole = psString(text);
    if ((pad + head + whole).length <= width) return [pad + head + whole];
    const inner = pad + "    ";
    const pieces = splitChars(text, Math.max(12, width - inner.length - 4), psCost, breakAfter).map(
      psString
    );
    return [
      pad + head + "(",
      ...pieces.map((piece, index) => inner + piece + (index < pieces.length - 1 ? " +" : "")),
      pad + ")",
    ];
  }

  // Text bodies are sent as UTF-8 bytes of a string literal, or of a structure that PowerShell 7's
  // ConvertTo-Json writes back as exactly the captured text. All output is ASCII, so the script's
  // own encoding and line endings can never change the data.

  // One double-quoted PowerShell character: line breaks, tabs and every non-ASCII code point are
  // explicit escapes, and the characters PowerShell expands are escaped.
  function psDoubleToken(ch) {
    switch (ch) {
      case "`":
        return "``";
      case '"':
        return '`"';
      case "$":
        return "`$";
      case "\r":
        return "`r";
      case "\n":
        return "`n";
      case "\t":
        return "`t";
      default:
        return /^[\x20-\x7e]$/.test(ch) ? ch : "`u{" + ch.codePointAt(0).toString(16) + "}";
    }
  }

  const psTextCost = (ch) =>
    /^[\x20-\x7e]$/.test(ch) ? (/['"`$]/.test(ch) ? 2 : 1) : psDoubleToken(ch).length;

  // Any text as one string literal: single-quoted when it is printable ASCII, else double-quoted.
  function psText(text) {
    if (/^[\x20-\x7e]*$/.test(text)) return "'" + text.replace(/'/g, "''") + "'";
    return '"' + Array.from(text, psDoubleToken).join("") + '"';
  }

  // Literal pieces for text too long for one line: one piece per line break, cut further at the
  // width, each quoted on its own and joined with "+".
  function psTextPieces(text, width, pad) {
    const budget = Math.max(12, width - pad.length - 4);
    const pieces = (text.match(/[^\n]*\n|[^\n]+/g) || [""])
      .flatMap((line) => splitChars(line, budget, psTextCost, TEXT_BREAK))
      .map(psText);
    return pieces.map((piece, index) => pad + piece + (index < pieces.length - 1 ? " +" : ""));
  }

  // True when a number literal PowerShell parses as an int, long or double prints back as the same
  // lexeme in ConvertTo-Json: longs, and plain decimals of at most 15 digits that need no exponent
  // (.NET switches to exponent notation sooner than Python, so this rule is stricter than Python's).
  function psExactNumber(lexeme) {
    if (!/^-?(?:0|[1-9]\d*)$/.test(lexeme)) {
      const match = /^-?(0|[1-9]\d*)\.(\d+)$/.exec(lexeme);
      if (!match || !/^(?:0|\d*[1-9])$/.test(match[2])) return false;
      if ((match[1] + match[2]).replace(/^0+/, "").length > 15) return false;
      const size = Math.abs(Number(lexeme));
      return size === 0 || (size >= 1e-4 && size < 1e16);
    }
    const digits = lexeme.replace("-", "");
    return (
      lexeme !== "-0" &&
      (digits.length < 19 || (digits.length === 19 && digits <= "9223372036854775807"))
    );
  }

  // ConvertTo-Json -Compress string escaping: JSON's named and \u00xx escapes, plus the three
  // characters Json.NET writes as escapes (U+0085, U+2028, U+2029). Everything else, including
  // non-ASCII text and < > & ' / DEL, is written literally.
  function psJsonString(value) {
    return dumpJsonString(value, false).replace(
      /[\u0085\u2028\u2029]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
    );
  }

  function psJsonDump(node) {
    switch (node.t) {
      case "obj":
        return (
          "{" +
          node.items.map(([key, item]) => psJsonString(key) + ":" + psJsonDump(item)).join(",") +
          "}"
        );
      case "arr":
        return "[" + node.items.map(psJsonDump).join(",") + "]";
      case "str":
        return psJsonString(node.v);
      case "num":
        return node.lex;
      default:
        return node.t;
    }
  }

  // Parsed JSON object or array whose [ordered]@{} / @() literal ConvertTo-Json writes back as
  // exactly `text`. Numbers must print unchanged, and keys must stay distinct in PowerShell's
  // case-insensitive hashtables (a clash is a parse error). String values that are themselves
  // such JSON become nested ConvertTo-Json nodes.
  function psPayload(text) {
    const tree = text ? parseJson(text) : null;
    if (tree?.t !== "obj" && tree?.t !== "arr") return null;
    const walk = (node) => {
      if (node.t === "num") return psExactNumber(node.lex);
      if (node.t === "arr") return node.items.every(walk);
      if (node.t !== "obj") return true;
      // Hashtable keys compare case-insensitively; a clash is a parse error, so such text stays text.
      const seen = new Set();
      for (const [key] of node.items) {
        const forms = [key.toLowerCase(), key.toUpperCase()];
        if (forms.some((form) => seen.has(form))) return false;
        forms.forEach((form) => seen.add(form));
      }
      return node.items.every(([, item]) => walk(item));
    };
    const exact = (node, source) => walk(node) && psJsonDump(node) === source;
    return exact(tree, text) ? nestJson(tree, exact) : null;
  }

  const psKey = (key) => (/^[A-Za-z_]\w*$/.test(key) ? key : psText(key));

  // A one-element array holding an array needs a unary comma, or @() would unroll the inner one.
  const psSole = (node) => (node.items.length === 1 && node.items[0].t === "arr" ? "," : "");

  const PS_NESTED = "(ConvertTo-Json -Compress -Depth 100 -InputObject ";

  // -InputObject takes an array, string or parenthesized object; [ordered] needs the parentheses.
  function psInline(node) {
    switch (node.t) {
      case "obj":
        return node.items.length
          ? "[ordered]@{ " +
              node.items.map(([key, item]) => psKey(key) + " = " + psInline(item)).join("; ") +
              " }"
          : "[ordered]@{}";
      case "arr":
        return "@(" + psSole(node) + node.items.map(psInline).join(", ") + ")";
      case "str":
        return psText(node.v);
      case "nest":
        return (
          PS_NESTED +
          (node.tree.t === "obj" ? "(" + psInline(node.tree) + ")" : psInline(node.tree)) +
          ")"
        );
      case "num":
        return node.lex;
      default:
        return "$" + node.t;
    }
  }

  // Lays a parsed JSON value out as a PowerShell literal: one line when it fits, otherwise one
  // member per line, indented four spaces per level. String values are never split.
  function psLines(node, pad, head, tail, width) {
    const one = psInline(node);
    if ((pad + head + one + tail).length <= width) return [pad + head + one + tail];
    if (node.t === "nest") {
      const object = node.tree.t === "obj";
      return psLines(
        node.tree,
        pad,
        head + PS_NESTED + (object ? "(" : ""),
        (object ? ")" : "") + ")" + tail,
        width
      );
    }
    if ((node.t !== "obj" && node.t !== "arr") || !node.items.length) {
      return [pad + head + one + tail];
    }
    const object = node.t === "obj";
    const inner = pad + "    ";
    const lines = [pad + head + (object ? "[ordered]@{" : "@(")];
    node.items.forEach((item, index) => {
      lines.push(
        ...(object
          ? psLines(item[1], inner, psKey(item[0]) + " = ", "", width)
          : psLines(
              item,
              inner,
              index === 0 ? psSole(node) : "",
              index < node.items.length - 1 ? "," : "",
              width
            ))
      );
    });
    lines.push(pad + (object ? "}" : ")") + tail);
    return lines;
  }

  // `$body` assignment lines: text as readable UTF-8 text (or structure), binary as base64.
  function psBodyLines(body, width) {
    const text = body.text;
    if (text != null && !hasBinaryControl(text)) {
      const payload = psPayload(text);
      if (payload) {
        return [
          ...psLines(payload, "", "$payload = ", "", width),
          "$json = ConvertTo-Json -Compress -Depth 100 -InputObject $payload",
          "$body = [Text.Encoding]::UTF8.GetBytes($json)",
        ];
      }
      const call = "$body = [Text.Encoding]::UTF8.GetBytes(";
      const one = call + psText(text) + ")";
      return one.length <= width ? [one] : [call, ...psTextPieces(text, width, "    "), ")"];
    }
    const pieces = splitFixed(base64(body.bytes), Math.max(8, width - 12), 4).map(
      (piece) => "'" + piece + "'"
    );
    const one = "$body = [Convert]::FromBase64String(" + pieces[0] + ")";
    if (pieces.length === 1 && one.length <= width) return [one];
    return [
      "$body = [Convert]::FromBase64String(",
      ...pieces.map((piece, index) => "    " + piece + (index < pieces.length - 1 ? " +" : "")),
      ")",
    ];
  }

  function powershell(request, width) {
    requireBodySupport(request, "PowerShell");
    const duplicate = duplicateHeader(request.headers);
    if (duplicate !== null) {
      throw new Error(
        'PowerShell cannot send duplicate header "' +
          duplicate +
          '" without merging it; choose another Copy as format.'
      );
    }
    const headers = request.headers;
    const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
    const rest = headers.filter(([name]) => name.toLowerCase() !== "content-type");
    const lines = [];
    if (rest.length) {
      lines.push("$headers = [ordered]@{");
      for (const [name, value] of rest) {
        lines.push("    " + psString(name) + " = " + psString(value));
      }
      lines.push("}");
    }
    const hasBody = request.body && !/^(GET|HEAD)$/i.test(request.method);
    if (hasBody) lines.push(...psBodyLines(request.body, width));
    const custom = !/^(GET|HEAD|POST|PUT|DELETE|TRACE|OPTIONS|MERGE|PATCH)$/i.test(request.method);
    lines.push("$params = @{");
    lines.push(...psValueLines("    ", "Uri = ", request.url, width, URL_BREAK));
    lines.push(
      ...psValueLines("    ", (custom ? "CustomMethod" : "Method") + " = ", request.method, width)
    );
    if (rest.length) lines.push("    Headers = $headers");
    if (contentType != null) {
      lines.push("    ContentType = " + psString(contentType));
    }
    if (hasBody) lines.push("    Body = $body");
    lines.push("}", "(Invoke-WebRequest @params).Content");
    return lines.join("\n");
  }

  // -- cURL --

  function curlGroups(request) {
    const groups = [["--globoff"], ["--url", request.url]];
    const head = request.method.toUpperCase() === "HEAD";
    if (head) {
      if (request.body?.bytes.length) {
        throw new Error("cURL cannot replay a HEAD request with a body.");
      }
      groups.push(["--head"]);
    } else {
      groups.push(["--request", request.method]);
    }
    for (const [name, value] of request.headers) groups.push(["--header", name + ": " + value]);
    if (request.body && !head) groups.push(["--data-binary", "@-"]);
    return groups;
  }

  const curlArgs = (request) => curlGroups(request).flat();

  // Quotes a word; a long one is split into adjacent quoted pieces joined by backslash-newline.
  // Continuation lines are not indented: the unquoted backslash-newline is removed, so leading
  // spaces would start a new word.
  function shellWord(value, budget, breakAfter) {
    const whole = shellString(value);
    if (whole.length <= budget) return whole;
    return splitChars(value, Math.max(12, budget - 4), shellCost, breakAfter)
      .map(shellString)
      .join("\\\n");
  }

  // Largest body passed as one command-line argument. Linux caps a single argument at 128 KiB and
  // Windows native programs started from Git Bash at about 32 K characters; larger text bodies
  // are piped through printf, which is a shell builtin and has no such limit.
  const INLINE_BODY_LIMIT = 24000;
  // Characters that must not appear literally in a pasted shell word: control characters (tab and
  // line breaks included: a pasted tab triggers completion), invisible format characters and
  // line or paragraph separators.
  const SHELL_ESCAPED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const SHELL_ESCAPES = new Map([
    ["\n", "\\n"],
    ["\r", "\\r"],
    ["\t", "\\t"],
    ["\\", "\\\\"],
    ["'", "\\'"],
  ]);

  // One shell word with the exact UTF-8 bytes of `text`, always on one line. Plain text is a
  // single-quoted literal. Text with characters that cannot be pasted safely uses ANSI-C $'...':
  // only those characters (and `!`, which interactive history expansion may touch) are escaped,
  // byte by byte so the result does not depend on the locale; the rest stays readable.
  function shellBody(text) {
    if (!SHELL_ESCAPED.test(text)) return "'" + text.replace(/'/g, "'\\''") + "'";
    let word = "$'";
    for (const ch of text) {
      if (SHELL_ESCAPES.has(ch)) word += SHELL_ESCAPES.get(ch);
      else if (ch === "!" || SHELL_ESCAPED.test(ch)) {
        for (const byte of new TextEncoder().encode(ch)) {
          word += "\\x" + byte.toString(16).padStart(2, "0");
        }
      } else word += ch;
    }
    return word + "'";
  }

  function curlBash(request, width) {
    const sends = Boolean(request.body) && request.method.toUpperCase() !== "HEAD";
    const text = request.body?.text;
    // Text goes inline with --data-raw; NUL, invalid UTF-8 and other binary bytes are piped.
    const inline =
      sends &&
      text != null &&
      !hasBinaryControl(text) &&
      request.body.bytes.length <= INLINE_BODY_LIMIT;
    const groups = curlGroups(request).filter(
      // curl already defaults to GET, and sending data makes it POST.
      ([name, value]) => !(name === "--request" && value === (sends ? "POST" : "GET"))
    );
    // curl adds a form-urlencoded Content-Type to any body unless the header is emptied.
    if (sends && !request.headers.some(([name]) => name.toLowerCase() === "content-type")) {
      groups.splice(groups.length - 1, 0, ["--header", "Content-Type:"]);
    }
    const words = groups.map((group) => {
      const [name, value] = group;
      if (group.length === 1) return name;
      if (name === "--header") return name + " " + shellString(value);
      if (inline && name === "--data-binary") return "--data-raw " + shellBody(text);
      // URLs wrap at the line width; a header or inline body stays one word.
      const flag = name + " ";
      return flag + shellWord(value, Math.max(12, width - 2 - flag.length - 2), URL_BREAK);
    });
    const command = "curl " + words.join(" \\\n  ");
    if (!sends || inline) return command;
    // printf reuses '%b' for each argument, so the pieces concatenate to the exact bytes.
    const escapes = Array.from(
      request.body.bytes,
      (byte) => "\\x" + byte.toString(16).padStart(2, "0")
    ).join("");
    const pieces = splitFixed(escapes, Math.max(8, width - 8), 4).map((piece) => "'" + piece + "'");
    return "printf '%b' \\\n  " + pieces.join(" \\\n  ") + " |\n" + command;
  }

  function windowsArgument(value) {
    return (
      '"' +
      String(value)
        .replace(/(\\*)"/g, '$1$1\\"')
        .replace(/(\\+)$/g, "$1$1") +
      '"'
    );
  }

  function curlCmd(request) {
    // An encoded PowerShell launcher prevents cmd.exe expanding percent signs or delayed variables.
    // curl still sends the request; its arguments and stdin bypass shell re-parsing entirely.
    // The launcher must stay on one line, so line width does not apply to it.
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
      "$start = New-Object Diagnostics.ProcessStartInfo",
      "$start.FileName = 'curl.exe'",
      "$start.UseShellExecute = $false",
      "$start.RedirectStandardInput = $true",
      "$start.Arguments = " + psString(curlArgs(request).map(windowsArgument).join(" ")),
      "$process = [Diagnostics.Process]::Start($start)",
    ];
    if (request.body) {
      lines.push(
        "$bytes = [Convert]::FromBase64String('" + base64(request.body.bytes) + "')",
        "$process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)"
      );
    }
    lines.push(
      "$process.StandardInput.Close()",
      "$process.WaitForExit()",
      "exit $process.ExitCode"
    );
    const script = lines.join("\n");
    const utf16 = new Uint8Array(script.length * 2);
    for (let index = 0; index < script.length; index++) {
      utf16[index * 2] = script.charCodeAt(index) & 255;
      utf16[index * 2 + 1] = script.charCodeAt(index) >>> 8;
    }
    const command = "powershell.exe -NoProfile -EncodedCommand " + base64(utf16);
    if (command.length > 8191) {
      throw new Error(
        "This request needs a " +
          command.length +
          "-character cmd.exe command; the limit is 8191. Choose another Copy as format."
      );
    }
    return command;
  }

  function serialize(format, entries, options) {
    if (!FORMATS.some(({ value }) => value === format))
      throw new Error("Unknown Copy as format: " + format);
    if (!entries.length) throw new Error("Select at least one request to copy.");
    const width = normalizeLineWidth(options?.lineWidth);
    const nestedJson = PYTHON_NESTED_JSON.some(({ value }) => value === options?.pythonNestedJson)
      ? options.pythonNestedJson
      : DEFAULT_PYTHON_NESTED_JSON;
    const library = PYTHON_LIBRARIES.some(({ value }) => value === options?.pythonLibrary)
      ? options.pythonLibrary
      : DEFAULT_PYTHON_LIBRARY;
    const requests = entries.map(normalize);
    // One request reads naturally as `response`; a batch needs distinct names to stay valid.
    const responseName = (index) => (requests.length > 1 ? "response" + (index + 1) : "response");
    const render = {
      fetch: (request, index) => javascript(request, true, width, responseName(index)),
      "node-fetch": (request, index) => javascript(request, false, width, responseName(index)),
      python: (request) => python(request, library === "httpx", width, nestedJson),
      powershell: (request) => powershell(request, width),
      "curl-bash": (request) => curlBash(request, width),
      "curl-cmd": curlCmd,
    }[format];
    const rendered = requests.map(render);
    if (format === "python") {
      // One stringify declaration serves every request in the batch that calls it.
      const helper = rendered.some((part) => part.stringify)
        ? pyStringifyDef(width) + "\n\n\n"
        : "";
      return helper + rendered.map((part) => part.call).join("\n\n") + "\n";
    }
    // A comment would not stop Windows PowerShell 5.1, which reads `u{...} escapes literally and
    // escapes ConvertTo-Json output differently, so it would silently send other bytes.
    const prefix =
      format === "powershell"
        ? "if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'This request needs PowerShell 7 or later.' }\n"
        : "";
    return prefix + rendered.join("\n\n") + "\n";
  }

  return {
    FORMATS,
    DEFAULT_FORMAT,
    DEFAULT_LINE_WIDTH,
    PYTHON_LIBRARIES,
    DEFAULT_PYTHON_LIBRARY,
    PYTHON_NESTED_JSON,
    DEFAULT_PYTHON_NESTED_JSON,
    normalizeLineWidth,
    isBinaryMedia,
    hasBinaryControl,
    normalize,
    requestBody,
    serialize,
  };
})();
