// Pure hex dump formatting and byte-first body extraction for the Network Hex view. No DOM, no
// I/O. Loaded after request-code.js (request bytes) and before request-body.js / request-detail.js.
"use strict";

const HexDump = (() => {
  const ROW = 16;
  // Dump pages are this many bytes (16384 rows) so a huge body never builds one giant model.
  const PAGE_BYTES = 1 << 18;
  const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
  // Media types that are never presented as text, even when the bytes happen to be UTF-8.
  const BINARY_MEDIA =
    /^(?:(?:image|audio|video|font)\/|application\/(?:octet-stream|zip|gzip|x-gzip|x-zip-compressed|zlib|pdf|(?:x-)?protobuf|x-google-protobuf|vnd\.google\.protobuf|grpc.*|(?:x-)?msgpack|cbor|wasm|zstd|x-bzip2?|x-tar|x-7z-compressed|vnd\.apache\.avro.*)$|.*\+(?:proto|protobuf|cbor)$)/i;
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const UTF8_CHARSET = /^(utf-?8|us-ascii)$/i;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

  // -- Formatting --

  // Conventional rows: lowercase hex offset (8+ digits, wide enough for the whole body so pages
  // line up), two 8-byte groups, `|ascii|` with printable 0x20..0x7e shown and everything else
  // as ".". The last row's hex is padded to full width. `start` must be a multiple of 16.
  function formatRows(bytes, { start = 0, end = bytes.length } = {}) {
    end = Math.min(end, bytes.length);
    if (end <= start) return "";
    const width = Math.max(8, (bytes.length - 1).toString(16).length);
    const rows = [];
    for (let at = start; at < end; at += ROW) {
      const stop = Math.min(at + ROW, end);
      let hex = "";
      let ascii = "";
      for (let index = 0; index < ROW; index++) {
        if (index === 8) hex += " ";
        const position = at + index;
        if (position < stop) {
          const byte = bytes[position];
          hex += HEX[byte] + " ";
          ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
        } else {
          hex += "   ";
        }
      }
      rows.push(at.toString(16).padStart(width, "0") + "  " + hex + " |" + ascii + "|");
    }
    return rows.join("\n");
  }

  // One page of the dump: bytes [start, end) of page `page` (clamped), absolute offsets.
  function dump(bytes, page = 0, pageBytes = PAGE_BYTES) {
    const pages = Math.max(1, Math.ceil(bytes.length / pageBytes));
    const index = Math.min(Math.max(0, Math.trunc(page) || 0), pages - 1);
    const start = index * pageBytes;
    const end = Math.min(bytes.length, start + pageBytes);
    return {
      text: formatRows(bytes, { start, end }),
      page: index,
      pages,
      start,
      end,
      total: bytes.length,
    };
  }

  function fromBase64(text) {
    if (typeof text !== "string" || !BASE64.test(text) || text.length % 4 === 1) return null;
    try {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch {
      return null;
    }
  }

  // -- Byte extraction --

  const absent = () => ({ status: "absent" });
  const empty = () => ({ status: "empty", bytes: new Uint8Array(0) });
  const unavailable = (reason, garbled = false) => ({ status: "unavailable", reason, garbled });

  function hasBinaryControl(text) {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x7f || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) return true;
    }
    return false;
  }

  // Replacement characters or controls in the first few KB: lossy text that is almost certainly
  // binary (compressed, protobuf, ...) rather than text that merely contains one odd character.
  function looksBinaryText(text) {
    const sample = text.length > 4096 ? text.slice(0, 4096) : text;
    let marks = 0;
    for (let index = 0; index < sample.length; index++) {
      const code = sample.charCodeAt(index);
      if (code === 0xfffd || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) marks++;
    }
    return marks > 0 && marks * 50 >= sample.length;
  }

  function hasContentEncoding(headers) {
    return (headers || []).some(
      (header) =>
        /^content-encoding$/i.test(String(header?.name)) &&
        !/^\s*(?:identity)?\s*$/i.test(String(header?.value))
    );
  }

  // Request body bytes come from RequestCode.requestBody, the one place that decides which
  // captured data are original bytes (explicit snapshot, base64 text, or text that is safely
  // UTF-8) and which are not. Its refusals become "unavailable" with the reason; reconstructed
  // form parameters are never presented as the original bytes.
  function requestBody(entry) {
    if (!entry?._record?.request) return absent();
    let body;
    try {
      body = RequestCode.requestBody(entry);
    } catch (error) {
      const detail = String(error?.message || error).replace(
        /^Cannot copy request(?: byte-for-byte)?:\s*/i,
        ""
      );
      const raw = entry._rawRequestBody;
      return unavailable(
        "No hex is shown because the original request bytes were not captured: " +
          detail +
          (typeof raw === "string" ? " Source shows the decoded text." : ""),
        typeof raw === "string" &&
          (hasContentEncoding(entry._record.request.headers) || looksBinaryText(raw))
      );
    }
    if (!body) return absent();
    if (body.structured) {
      return unavailable(
        "Only parsed form parameters were captured, not the raw request body, so no original " +
          "bytes can be shown."
      );
    }
    if (!body.bytes.length) return empty();
    const encoding = entry._record.request.bodyEncoding || entry._requestPostData?.encoding;
    const exact = typeof entry._requestBodyBytes?.base64 === "string" || encoding === "base64";
    const binary = body.text === null || hasBinaryControl(body.text);
    const source = exact ? entry._requestBodyBytes?.source || "request.base64" : "utf8-text";
    return { status: "bytes", bytes: body.bytes, text: body.text, binary, exact, source };
  }

  // -- Response (DevTools cache: decoded/decompressed content, never wire bytes) --

  function mediaType(value) {
    return /^\s*([^;\s]*)/.exec(value || "")[1].toLowerCase();
  }

  function charsetOf(value) {
    return /charset\s*=\s*["']?([^\s;"']+)/i.exec(value || "")?.[1];
  }

  function headerValue(headers, name) {
    return (headers || []).find((header) => String(header?.name).toLowerCase() === name)?.value;
  }

  // Bytes are always shown; `text` is only set when they are safely presentable UTF-8 text.
  function responseBytes(bytes, contentType, exact) {
    if (!bytes.length) return empty();
    let text = null;
    const charset = charsetOf(contentType);
    if (!BINARY_MEDIA.test(mediaType(contentType)) && (!charset || UTF8_CHARSET.test(charset))) {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    const binary = text === null || hasBinaryControl(text);
    const source = exact ? "response.base64" : "utf8-text";
    return { status: "bytes", bytes, text, binary, exact, source };
  }

  // Response content is base64 text (exact cached bytes) or decoded text; text becomes bytes only
  // when that is unambiguous (declared UTF-8 or undeclared, no replacement characters).
  function responseBody(entry) {
    const response = entry?._record?.response;
    const raw = entry?._rawResponseBody;
    if (!response || raw == null) return absent();
    const contentType =
      headerValue(response.headers, "content-type") ?? response.bodyMimeType ?? "";
    const encoding = response.bodyEncoding || null;
    if (encoding === "base64") {
      const bytes = fromBase64(raw);
      return bytes
        ? responseBytes(bytes, contentType, true)
        : unavailable("The captured base64 response content is invalid.");
    }
    if (encoding) {
      return unavailable(`The captured response uses an unsupported encoding (${encoding}).`);
    }
    if (raw === "") return empty();
    const charset = charsetOf(contentType);
    if (charset && !UTF8_CHARSET.test(charset)) {
      return unavailable(
        `The response is declared as ${charset}, but only decoded text was captured, so its ` +
          "original bytes are not available. Source shows the decoded text."
      );
    }
    if (raw.includes("\ufffd") || LONE_SURROGATE.test(raw)) {
      return unavailable(
        "The captured response text contains replacement (U+FFFD) or unpaired surrogate " +
          "characters, so its original bytes were not captured and no hex can be shown. Source " +
          "shows the decoded text.",
        BINARY_MEDIA.test(mediaType(contentType)) || looksBinaryText(raw)
      );
    }
    return responseBytes(new TextEncoder().encode(raw), contentType, false);
  }

  // Hex is the better default when the bytes are binary or only a garbled text copy exists.
  function prefersHex(result) {
    return Boolean(result) && ((result.status === "bytes" && result.binary) || !!result.garbled);
  }

  // One-line note about where the shown bytes come from; never claims bytes it does not have.
  function describe(result, side) {
    if (result.status === "unavailable") return result.reason;
    if (result.status === "empty") return "Empty body (0 bytes).";
    if (result.status === "absent") return "No body was captured.";
    const size = `${result.bytes.length.toLocaleString("en-US")} byte${result.bytes.length === 1 ? "" : "s"}`;
    if (side === "response") {
      return result.exact
        ? `${size} of captured response content (DevTools cache: decoded/decompressed content, not the compressed wire bytes).`
        : `${size}: UTF-8 re-encoding of the captured response text (DevTools cache: decoded content, not the compressed wire bytes).`;
    }
    return result.exact
      ? `${size} of the exact captured request body.`
      : `${size}: UTF-8 re-encoding of the captured request text (DevTools did not expose raw bytes).`;
  }

  return {
    ROW,
    PAGE_BYTES,
    formatRows,
    dump,
    fromBase64,
    requestBody,
    responseBody,
    prefersHex,
    describe,
  };
})();
