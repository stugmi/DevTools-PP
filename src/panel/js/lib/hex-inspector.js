// Pure hex helpers: data inspector decoding, byte search, needle parsing, selection formatting.
// Classic script: defines the global `HexInspector`. No DOM access.

const HexInspector = (() => {
  const CONTROL_NAMES = [
    "NUL",
    "SOH",
    "STX",
    "ETX",
    "EOT",
    "ENQ",
    "ACK",
    "BEL",
    "BS",
    "TAB",
    "LF",
    "VT",
    "FF",
    "CR",
    "SO",
    "SI",
    "DLE",
    "DC1",
    "DC2",
    "DC3",
    "DC4",
    "NAK",
    "SYN",
    "ETB",
    "CAN",
    "EM",
    "SUB",
    "ESC",
    "FS",
    "GS",
    "RS",
    "US",
  ];

  const hex2 = (n) => n.toString(16).padStart(2, "0");

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function fmtFloat(v, digits) {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    if (v === 0) return Object.is(v, -0) ? "-0" : "0";
    return String(Number(v.toPrecision(digits)));
  }

  // Generic small-float decoder (sign, expBits, fracBits).
  function decodeSmallFloat(bits, expBits, fracBits) {
    const bias = (1 << (expBits - 1)) - 1;
    const expMax = (1 << expBits) - 1;
    const sign = (bits >> (expBits + fracBits)) & 1 ? -1 : 1;
    const exp = (bits >> fracBits) & expMax;
    const frac = bits & ((1 << fracBits) - 1);
    if (exp === expMax) return frac ? NaN : sign * Infinity;
    if (exp === 0) return sign * frac * 2 ** (1 - bias - fracBits);
    return sign * (1 + frac / 2 ** fracBits) * 2 ** (exp - bias);
  }

  function fmtCodePoint(cp) {
    const u = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return u;
    return `'${String.fromCodePoint(cp)}' ${u}`;
  }

  function asciiChar(b) {
    if (b >= 0x20 && b < 0x7f) return `'${String.fromCharCode(b)}'`;
    if (b < 0x20) return `'\\x${hex2(b)}' (${CONTROL_NAMES[b]})`;
    if (b === 0x7f) return `'\\x7f' (DEL)`;
    return `'\\x${hex2(b)}'`;
  }

  function utf8Char(bytes, offset) {
    const b0 = bytes[offset];
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b0 < 0x80) return fmtCodePoint(b0);
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else return "Invalid";
    if (offset + need >= bytes.length) return "Invalid";
    for (let i = 1; i <= need; i++) {
      const b = bytes[offset + i];
      if ((b & 0xc0) !== 0x80) return "Invalid";
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "Invalid";
    return fmtCodePoint(cp);
  }

  function utf16Char(view, offset, le) {
    const u = view.getUint16(offset, le);
    if (u >= 0xd800 && u <= 0xdbff && offset + 4 <= view.byteLength) {
      const lo = view.getUint16(offset + 2, le);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        return fmtCodePoint(((u - 0xd800) << 10) + (lo - 0xdc00) + 0x10000);
      }
    }
    if (u >= 0xd800 && u <= 0xdfff) return `U+${u.toString(16).toUpperCase()} (lone surrogate)`;
    return fmtCodePoint(u);
  }

  // Returns "value (N bytes)" or null if truncated / longer than 10 bytes.
  function leb128(bytes, offset, signed) {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset + i >= bytes.length) return null;
      const b = bytes[offset + i];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (signed && b & 0x40) result -= 1n << shift;
        return `${result} (${i + 1} bytes)`;
      }
    }
    return null;
  }

  function inspect(bytes, offset, { littleEndian = true } = {}) {
    const le = littleEndian !== false;
    const len = bytes.length;
    const view = viewOf(bytes);
    const has = (n) => Number.isInteger(offset) && offset >= 0 && offset + n <= len;
    const at = (n, fn) => (has(n) ? String(fn()) : null);

    // Assemble n bytes (n <= 6) into an exact Number honoring endianness.
    const assemble = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const b = bytes[offset + (le ? n - 1 - i : i)];
        v = v * 256 + b;
      }
      return v;
    };
    const signedOf = (n) => {
      const v = assemble(n);
      return v >= 2 ** (8 * n - 1) ? v - 2 ** (8 * n) : v;
    };

    const rows = [
      ["binary", "Binary", () => (has(1) ? bytes[offset].toString(2).padStart(8, "0") : null)],
      ["uint8", "uint8_t", () => at(1, () => bytes[offset])],
      ["int8", "int8_t", () => at(1, () => view.getInt8(offset))],
      ["uint16", "uint16_t", () => at(2, () => view.getUint16(offset, le))],
      ["int16", "int16_t", () => at(2, () => view.getInt16(offset, le))],
      ["uint24", "uint24_t", () => at(3, () => assemble(3))],
      ["int24", "int24_t", () => at(3, () => signedOf(3))],
      ["uint32", "uint32_t", () => at(4, () => view.getUint32(offset, le))],
      ["int32", "int32_t", () => at(4, () => view.getInt32(offset, le))],
      ["uint48", "uint48_t", () => at(6, () => assemble(6))],
      ["int48", "int48_t", () => at(6, () => signedOf(6))],
      ["uint64", "uint64_t", () => at(8, () => view.getBigUint64(offset, le))],
      ["int64", "int64_t", () => at(8, () => view.getBigInt64(offset, le))],
      [
        "half",
        "float16",
        () => at(2, () => fmtFloat(decodeSmallFloat(view.getUint16(offset, le), 5, 10), 9)),
      ],
      ["float32", "float", () => at(4, () => fmtFloat(view.getFloat32(offset, le), 9))],
      ["float64", "double", () => at(8, () => fmtFloat(view.getFloat64(offset, le), 17))],
      [
        "bfloat16",
        "bfloat16",
        () => at(2, () => fmtFloat(decodeSmallFloat(view.getUint16(offset, le), 8, 7), 9)),
      ],
      ["uleb128", "ULEB128", () => (has(1) ? leb128(bytes, offset, false) : null)],
      ["sleb128", "SLEB128", () => (has(1) ? leb128(bytes, offset, true) : null)],
      [
        "bool",
        "bool",
        () =>
          at(1, () => (bytes[offset] === 0 ? "false" : bytes[offset] === 1 ? "true" : "Invalid")),
      ],
      ["ascii", "ASCII char", () => at(1, () => asciiChar(bytes[offset]))],
      ["utf8", "UTF-8 char", () => (has(1) ? utf8Char(bytes, offset) : null)],
      ["utf16", "UTF-16 char", () => (has(2) ? utf16Char(view, offset, le) : null)],
    ];

    return rows.map(([id, label, fn]) => ({ id, label, value: fn() }));
  }

  function find(bytes, needle, from, { backward = false } = {}) {
    const n = needle ? needle.length : 0;
    if (n === 0 || n > bytes.length) return -1;
    const last = bytes.length - n;
    const matchesAt = (i) => {
      for (let j = 0; j < n; j++) if (bytes[i + j] !== needle[j]) return false;
      return true;
    };
    if (backward) {
      const start = Math.min(Number.isInteger(from) ? from - 1 : bytes.length - 1, last);
      for (let i = start; i >= 0; i--) if (matchesAt(i)) return i;
      return -1;
    }
    for (let i = Math.max(0, Number.isInteger(from) ? from : 0); i <= last; i++) {
      if (matchesAt(i)) return i;
    }
    return -1;
  }

  function parseNeedle(text, mode) {
    if (typeof text !== "string") return null;
    if (mode === "text") {
      return text === "" ? null : new TextEncoder().encode(text);
    }
    if (mode !== "hex") return null;
    const digits = text
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((tok) => tok.replace(/^0x/i, ""))
      .join("");
    if (digits === "" || digits.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(digits)) return null;
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
    return out;
  }

  function formatSelection(bytes, start, end, format) {
    const s = Math.max(0, Math.min(bytes.length, start | 0));
    const e = Math.max(0, Math.min(bytes.length, end | 0));
    if (e <= s) return "";
    const sel = Array.from(bytes.subarray(s, e));
    switch (format) {
      case "hex":
        return sel.map(hex2).join(" ");
      case "hex-compact":
        return sel.map(hex2).join("");
      case "c": {
        const items = sel.map((b) => `0x${hex2(b)}`);
        if (items.length <= 12) return `{ ${items.join(", ")} }`;
        const lines = [];
        for (let i = 0; i < items.length; i += 12)
          lines.push(`  ${items.slice(i, i + 12).join(", ")}`);
        return `{\n${lines.join(",\n")}\n}`;
      }
      case "base64":
        return btoa(sel.map((b) => String.fromCharCode(b)).join(""));
      case "python":
        return `bytes.fromhex("${sel.map(hex2).join("")}")`;
      case "ascii":
        return sel.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
      default:
        return "";
    }
  }

  return { inspect, find, parseNeedle, formatSelection };
})();
