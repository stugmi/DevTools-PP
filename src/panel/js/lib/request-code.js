// Generates replay code from captured request fields without reading response bodies or doing I/O.
"use strict";

const RequestCode = (() => {
  const FORMATS = Object.freeze([
    { value: "fetch", label: "Browser fetch" },
    { value: "node-fetch", label: "Node.js fetch" },
    { value: "python-requests", label: "Python requests" },
    { value: "python-httpx", label: "Python httpx" },
    { value: "powershell", label: "PowerShell" },
    { value: "curl-bash", label: "cURL (bash)" },
    { value: "curl-cmd", label: "cURL (cmd)" },
  ]);
  const DEFAULT_FORMAT = "fetch";
  const DEFAULT_LINE_WIDTH = 88;
  const MIN_LINE_WIDTH = 40;
  const MAX_LINE_WIDTH = 160;
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
  const BINARY_MEDIA =
    /^(?:(?:image|audio|video|font)\/|application\/(?:octet-stream|zip|gzip|x-gzip|x-zip-compressed|zlib|pdf|(?:x-)?protobuf|x-google-protobuf|vnd\.google\.protobuf|grpc.*|(?:x-)?msgpack|cbor|wasm|zstd|x-bzip2?|x-tar|x-7z-compressed|vnd\.apache\.avro.*)$|.*\+(?:proto|protobuf|cbor)$)/i;
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const URL_BREAK = /[/?&#]/;
  const TEXT_BREAK = /[\s,;&]/;

  // Line width is a formatting preference: finite numbers clamp to 40..160, anything else is 88.
  function normalizeLineWidth(value) {
    let width = value;
    if (typeof width === "string" && width.trim() !== "") width = Number(width);
    if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_LINE_WIDTH;
    return Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, Math.trunc(width)));
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

  const jsCost = (ch) => Math.max(1, jsString(ch).length - 2);
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

  // Exact bytes always win; `text` is only set when the bytes are safely presentable UTF-8 text.
  function bodyShape(bytes, contentType, encoded) {
    let text = null;
    const charset = charsetOf(contentType);
    if (
      !encoded &&
      !BINARY_MEDIA.test(mediaType(contentType)) &&
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
  // fits, otherwise the value is split into "a" + "b" pieces on following lines.
  function jsValueLines(pad, head, text, width, tail, breakAfter) {
    const whole = jsString(text);
    if ((pad + head + whole + tail).length <= width) return [pad + head + whole + tail];
    const lines = head.trim() ? [pad + head.trimEnd()] : [];
    const inner = head.trim() ? pad + "  " : pad;
    const pieces = splitChars(text, Math.max(12, width - inner.length - 4), jsCost, breakAfter).map(
      jsString
    );
    pieces.forEach((piece, index) => {
      lines.push(inner + piece + (index < pieces.length - 1 ? " +" : tail));
    });
    return lines;
  }

  function jsPairLines(pad, name, value, width) {
    const one = pad + "[" + jsString(name) + ", " + jsString(value) + "],";
    if (one.length <= width) return [one];
    const inner = pad + "  ";
    return [
      pad + "[",
      ...jsValueLines(inner, "", name, width, ",", TEXT_BREAK),
      ...jsValueLines(inner, "", value, width, ",", TEXT_BREAK),
      pad + "],",
    ];
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
      const pairs =
        duplicate !== null ||
        headers.some(
          ([hname]) =>
            hname === "__proto__" ||
            /^(?:0|[1-9]\d*)$/.test(hname) ||
            deeper.length + jsString(hname).length + 3 > width
        );
      lines.push(base + (pairs ? "headers: [" : "headers: {"));
      for (const [hname, value] of headers) {
        lines.push(
          ...(pairs
            ? jsPairLines(deeper, hname, value, width)
            : jsValueLines(deeper, jsString(hname) + ": ", value, width, ",", TEXT_BREAK))
        );
      }
      lines.push(base + (pairs ? "]," : "},"));
    }
    if (browser) lines.push(base + 'credentials: "include",');
    if (request.body && !/^(GET|HEAD)$/i.test(request.method)) {
      if (request.body.text != null) {
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
  // Output never imports anything; the caller supplies `requests` or `httpx`. Code is laid out from
  // a small node tree: s (string), b (bytes), r (raw token), d (dict), l (list/tuple), c (call).

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
      case "d":
        return node.items.length ? null : "{}";
      case "l": {
        if (node.multi && node.items.length) return null;
        const parts = node.items.map(pyInline);
        if (parts.includes(null)) return null;
        return node.open + parts.join(", ") + node.close;
      }
      case "c": {
        if (node.args.length > 1) return null;
        if (!node.args.length) return node.name + "()";
        const value = pyInline(node.args[0][1]);
        return value === null ? null : node.name + "(" + node.args[0][0] + "=" + value + ")";
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
        const lines = [pad + prefix + node.name + "("];
        for (const [keyword, value] of node.args) {
          lines.push(...pyRender(value, inner, keyword + "=", ",", width));
        }
        lines.push(pad + ")" + suffix);
        return lines;
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

  // True when Python's int/float repr and json.dumps print this exact lexeme.
  function exactNumber(lexeme) {
    if (/^-?(?:0|[1-9]\d*)$/.test(lexeme)) return lexeme !== "-0" && lexeme.length <= 64;
    const match = /^-?(0|[1-9]\d*)\.(\d+)$/.exec(lexeme);
    if (!match || !/^(?:0|\d*[1-9])$/.test(match[2])) return false;
    if ((match[1] + match[2]).replace(/^0+/, "").length > 15) return false;
    const size = Math.abs(Number(lexeme));
    return size === 0 || (size >= 1e-4 && size < 1e16);
  }

  // json.dumps output for the parsed value: requests uses defaults, httpx 0.28+ is compact and
  // keeps non-ASCII characters.
  function dumpJson(node, ascii) {
    const sep = ascii ? [", ", ": "] : [",", ":"];
    switch (node.t) {
      case "obj":
        return (
          "{" +
          node.items
            .map(([key, item]) => dumpJsonString(key, ascii) + sep[1] + dumpJson(item, ascii))
            .join(sep[0]) +
          "}"
        );
      case "arr":
        return "[" + node.items.map((item) => dumpJson(item, ascii)).join(sep[0]) + "]";
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

  function jsonToPy(node) {
    switch (node.t) {
      case "obj":
        return {
          t: "d",
          items: node.items.map(([key, item]) => [pyStr(key, TEXT_BREAK), jsonToPy(item)]),
        };
      case "arr":
        return { t: "l", open: "[", close: "]", items: node.items.map(jsonToPy) };
      case "str":
        return pyStr(node.v, TEXT_BREAK);
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
        items: pairs.map(([name, value]) => [pyStr(name, TEXT_BREAK), pyStr(value, TEXT_BREAK)]),
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
          items: [pyStr(name), pyStr(value, TEXT_BREAK)],
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
        pyStr(name, TEXT_BREAK),
        values.length === 1
          ? pyStr(values[0], TEXT_BREAK)
          : {
              t: "l",
              open: "[",
              close: "]",
              items: values.map((value) => pyStr(value, TEXT_BREAK)),
            },
      ]),
    };
  }

  function hasBinaryControl(text) {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x7f || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) return true;
    }
    return false;
  }

  // Chooses the Python body argument; only forms whose library encoding reproduces the captured
  // bytes exactly (or whose only capture is structured parameters) replace the raw body.
  function pyBody(request, httpx) {
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
    const charset = charsetOf(contentType);
    if (
      text &&
      contentType != null &&
      /^(?:application|text)\/(?:json|[\w.+-]+\+json)$/.test(media) &&
      (!charset || /^utf-?8$/i.test(charset))
    ) {
      const tree = parseJson(text);
      if (tree && tree.t !== "null" && dumpJson(tree, !httpx) === text) {
        return ["json", jsonToPy(tree)];
      }
    }
    if (media === "application/x-www-form-urlencoded") {
      const pairs = parseForm(text);
      const node = pairs && formToPy(pairs, httpx);
      if (node) return ["data", node];
    }
    // Pass non-ASCII UTF-8 text as bytes so requests computes its byte length.
    return [
      rawKeyword,
      { t: "s", text, brk: TEXT_BREAK, enc: !httpx && body.bytes.length !== text.length },
    ];
  }

  function pyHeaders(headers, httpx) {
    if (!headers.length) return null;
    const duplicate = duplicateHeader(headers);
    if (duplicate !== null && !httpx) {
      throw new Error(
        'Python requests cannot send duplicate header "' +
          duplicate +
          '" without merging it; choose Python httpx or another Copy as format.'
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
          items: [pyStr(name), pyStr(value, TEXT_BREAK)],
        })),
      };
    }
    return {
      t: "d",
      items: headers.map(([name, value]) => [pyStr(name, TEXT_BREAK), pyStr(value, TEXT_BREAK)]),
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
          "Requests normalizes this URL; choose Python httpx/cURL to preserve exact request target."
        );
      }
    }
  }

  function python(request, httpx, width) {
    if (!httpx) requireExactRequestsUrl(request.url);
    const helper = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method)
      ? request.method.toLowerCase()
      : null;
    const body = pyBody(request, httpx);
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
    return pyRender({ t: "c", name, args }, 0, "response = ", "", width).join("\n");
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
        lines.push(...psValueLines("    ", psString(name) + " = ", value, width, TEXT_BREAK));
      }
      lines.push("}");
    }
    const hasBody = request.body && !/^(GET|HEAD)$/i.test(request.method);
    if (hasBody) {
      const pieces = splitFixed(base64(request.body.bytes), Math.max(8, width - 12), 4).map(
        (piece) => "'" + piece + "'"
      );
      const one = "$body = [Convert]::FromBase64String(" + pieces[0] + ")";
      if (pieces.length === 1 && one.length <= width) lines.push(one);
      else {
        lines.push("$body = [Convert]::FromBase64String(");
        pieces.forEach((piece, index) =>
          lines.push("    " + piece + (index < pieces.length - 1 ? " +" : ""))
        );
        lines.push(")");
      }
    }
    const custom = !/^(GET|HEAD|POST|PUT|DELETE|TRACE|OPTIONS|MERGE|PATCH)$/i.test(request.method);
    lines.push("$params = @{");
    lines.push(...psValueLines("    ", "Uri = ", request.url, width, URL_BREAK));
    lines.push(
      ...psValueLines("    ", (custom ? "CustomMethod" : "Method") + " = ", request.method, width)
    );
    if (rest.length) lines.push("    Headers = $headers");
    if (contentType != null) {
      lines.push(...psValueLines("    ", "ContentType = ", contentType, width, TEXT_BREAK));
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

  function curlBash(request, width) {
    const groups = curlGroups(request).map((group) => {
      const flag = group.length > 1 ? group[0] + " " : "";
      const value = group[group.length - 1];
      const breakAfter = group[0] === "--url" ? URL_BREAK : TEXT_BREAK;
      return flag + shellWord(value, Math.max(12, width - 2 - flag.length - 2), breakAfter);
    });
    const command = "curl " + groups.join(" \\\n  ");
    if (!request.body) return command;
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
    const requests = entries.map(normalize);
    // One request reads naturally as `response`; a batch needs distinct names to stay valid.
    const responseName = (index) => (requests.length > 1 ? "response" + (index + 1) : "response");
    const render = {
      fetch: (request, index) => javascript(request, true, width, responseName(index)),
      "node-fetch": (request, index) => javascript(request, false, width, responseName(index)),
      "python-requests": (request) => python(request, false, width),
      "python-httpx": (request) => python(request, true, width),
      powershell: (request) => powershell(request, width),
      "curl-bash": (request) => curlBash(request, width),
      "curl-cmd": curlCmd,
    }[format];
    const prefix = format === "powershell" ? "# Requires PowerShell 7 or later.\n" : "";
    return prefix + requests.map(render).join("\n\n") + "\n";
  }

  return {
    FORMATS,
    DEFAULT_FORMAT,
    DEFAULT_LINE_WIDTH,
    normalizeLineWidth,
    normalize,
    requestBody,
    serialize,
  };
})();
