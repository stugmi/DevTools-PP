// Behavioral tests for the pure hex inspector (src/panel/js/lib/hex-inspector.js).
// Run with `node --test scripts/test-hex-inspector.js`. Classic script defining a top-level
// `HexInspector` const, evaluated in a vm context (no DOM needed).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({ TextDecoder, TextEncoder, atob, btoa, Uint8Array, DataView });
const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "lib", "hex-inspector.js"),
  "utf8"
);
const HexInspector = vm.runInContext(`${source}\nHexInspector`, context);

const U8 = (...b) => Uint8Array.from(b);
const val = (bytes, offset, id, opts) =>
  HexInspector.inspect(bytes, offset, opts).find((r) => r.id === id).value;

const SAMPLE = U8(0x16, 0, 0, 0, 0x47, 0, 0x01, 0xc3);

test("integers little endian", () => {
  assert.equal(val(SAMPLE, 0, "uint8"), "22");
  assert.equal(val(SAMPLE, 0, "uint16"), "22");
  assert.equal(val(SAMPLE, 0, "uint32"), "22");
  const dv = new DataView(SAMPLE.buffer);
  assert.equal(val(SAMPLE, 0, "int64"), String(dv.getBigInt64(0, true)));
  assert.equal(val(SAMPLE, 0, "uint64"), String(dv.getBigUint64(0, true)));
  assert.equal(val(SAMPLE, 7, "int8"), "-61");
});

test("integers big endian", () => {
  const be = { littleEndian: false };
  assert.equal(val(SAMPLE, 0, "uint32", be), String(0x16000000));
  assert.equal(val(SAMPLE, 0, "uint16", be), String(0x1600));
  const dv = new DataView(SAMPLE.buffer);
  assert.equal(val(SAMPLE, 0, "int64", be), String(dv.getBigInt64(0, false)));
});

test("24 and 48 bit integers", () => {
  const b = U8(0x01, 0x02, 0xff, 0xff, 0xff, 0xff);
  assert.equal(val(b, 0, "uint24"), String(0xff0201));
  assert.equal(val(b, 0, "int24"), String(0xff0201 - 0x1000000));
  assert.equal(val(b, 0, "uint24", { littleEndian: false }), String(0x0102ff));
  assert.equal(val(b, 0, "uint48"), String(0xffffffff0201));
  assert.equal(val(b, 0, "int48"), String(0xffffffff0201 - 2 ** 48));
  assert.equal(val(b, 0, "int48", { littleEndian: false }), String(0x0102ffffffff));
});

test("64-bit values above 2^53 are exact", () => {
  const b = U8(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  assert.equal(val(b, 0, "uint64"), "18446744073709551615");
  assert.equal(val(b, 0, "int64"), "-1");
  const c = U8(0x01, 0, 0, 0, 0, 0, 0x20, 0x00);
  assert.equal(val(c, 0, "uint64"), String((1n << 53n) + 1n));
});

test("binary string", () => {
  assert.equal(val(SAMPLE, 0, "binary"), "00010110");
});

test("floats", () => {
  assert.equal(val(U8(0, 0, 0x80, 0x3f), 0, "float32"), "1");
  assert.equal(val(U8(0x3f, 0x80, 0, 0), 0, "float32", { littleEndian: false }), "1");
  assert.equal(val(U8(0, 0, 0, 0, 0, 0, 0xf0, 0x3f), 0, "float64"), "1");
  assert.equal(val(U8(0, 0, 0xc0, 0x7f), 0, "float32"), "NaN");
  assert.equal(val(U8(0, 0, 0x80, 0x7f), 0, "float32"), "Infinity");
  assert.equal(val(U8(0, 0, 0x80, 0xff), 0, "float32"), "-Infinity");
  assert.equal(val(U8(0, 0, 0, 0x80), 0, "float32"), "-0");
});

test("float16", () => {
  assert.equal(val(U8(0x00, 0x3c), 0, "half"), "1");
  assert.equal(val(U8(0x3c, 0x00), 0, "half", { littleEndian: false }), "1");
  assert.equal(val(U8(0x00, 0x7c), 0, "half"), "Infinity");
  assert.equal(val(U8(0x00, 0xfc), 0, "half"), "-Infinity");
  assert.equal(val(U8(0x01, 0x7c), 0, "half"), "NaN");
  assert.equal(val(U8(0x00, 0x80), 0, "half"), "-0");
  assert.equal(val(U8(0x01, 0x00), 0, "half"), "5.96046448e-8");
  assert.equal(val(U8(0x00, 0xc0), 0, "half"), "-2");
});

test("bfloat16", () => {
  assert.equal(val(U8(0x80, 0x3f), 0, "bfloat16"), "1");
  assert.equal(val(U8(0x3f, 0x80), 0, "bfloat16", { littleEndian: false }), "1");
  assert.equal(val(U8(0x80, 0x7f), 0, "bfloat16"), "Infinity");
  assert.equal(val(U8(0xc1, 0x7f), 0, "bfloat16"), "NaN");
});

test("LEB128", () => {
  assert.equal(val(U8(0xe5, 0x8e, 0x26), 0, "uleb128"), "624485 (3 bytes)");
  assert.equal(val(U8(0xc0, 0xbb, 0x78), 0, "sleb128"), "-123456 (3 bytes)");
  assert.equal(val(U8(0x7f), 0, "sleb128"), "-1 (1 bytes)");
  assert.equal(val(U8(0x02), 0, "uleb128"), "2 (1 bytes)");
  assert.equal(val(U8(0xe5, 0x8e), 0, "uleb128"), null);
  assert.equal(val(U8(0xe5, 0x8e), 0, "sleb128"), null);
  const overlong = new Uint8Array(11).fill(0x80);
  overlong[10] = 0x01;
  assert.equal(val(overlong, 0, "uleb128"), null);
});

test("values running past the end are null", () => {
  const b = U8(0x01, 0x02, 0x03);
  assert.equal(val(b, 0, "uint16"), "513");
  assert.equal(val(b, 0, "uint32"), null);
  assert.equal(val(b, 0, "int64"), null);
  assert.equal(val(b, 2, "uint16"), null);
  assert.equal(val(b, 2, "uint8"), "3");
  assert.equal(val(b, 3, "uint8"), null);
  assert.equal(val(b, 3, "binary"), null);
  assert.equal(val(b, 0, "float32"), null);
});

test("inspect returns every contract id in order", () => {
  const ids = HexInspector.inspect(SAMPLE, 0).map((r) => r.id);
  for (const id of [
    "binary",
    "uint8",
    "int8",
    "uint16",
    "int16",
    "uint24",
    "int24",
    "uint32",
    "int32",
    "uint48",
    "int48",
    "uint64",
    "int64",
    "half",
    "float32",
    "float64",
    "bfloat16",
    "uleb128",
    "sleb128",
    "bool",
    "ascii",
    "utf8",
    "utf16",
  ]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(ids.indexOf("uint8") < ids.indexOf("uint16"));
  assert.ok(ids.indexOf("uint16") < ids.indexOf("uint64"));
});

test("bool", () => {
  assert.equal(val(U8(0), 0, "bool"), "false");
  assert.equal(val(U8(1), 0, "bool"), "true");
  assert.equal(val(U8(2), 0, "bool"), "Invalid");
});

test("ASCII char", () => {
  assert.equal(val(U8(0x41), 0, "ascii"), "'A'");
  assert.match(val(U8(0x16), 0, "ascii"), /\\x16/);
  assert.match(val(U8(0x00), 0, "ascii"), /NUL/);
  assert.match(val(U8(0x7f), 0, "ascii"), /DEL/);
  assert.equal(val(U8(0xc3), 0, "ascii"), "'\\xc3'");
});

test("UTF-8 char", () => {
  assert.match(val(U8(0x41), 0, "utf8"), /U\+0041/);
  assert.match(val(U8(0xc3, 0xa9), 0, "utf8"), /'\u00e9' U\+00E9/);
  assert.match(val(U8(0xe2, 0x82, 0xac), 0, "utf8"), /'\u20ac' U\+20AC/);
  assert.match(val(U8(0xf0, 0x9f, 0x98, 0x80), 0, "utf8"), /U\+1F600/);
  assert.equal(val(U8(0xc0, 0x80), 0, "utf8"), "Invalid");
  assert.equal(val(U8(0xe0, 0x80, 0x80), 0, "utf8"), "Invalid");
  assert.equal(val(U8(0xed, 0xa0, 0x80), 0, "utf8"), "Invalid");
  assert.equal(val(U8(0xf4, 0x90, 0x80, 0x80), 0, "utf8"), "Invalid");
  assert.equal(val(U8(0xc3), 0, "utf8"), "Invalid");
  assert.equal(val(U8(0x80), 0, "utf8"), "Invalid");
});

test("UTF-16 char honors endianness", () => {
  assert.match(val(U8(0x41, 0x00), 0, "utf16"), /U\+0041/);
  assert.match(val(U8(0x00, 0x41), 0, "utf16", { littleEndian: false }), /U\+0041/);
  assert.equal(val(U8(0x41), 0, "utf16"), null);
});

test("parseNeedle", () => {
  assert.deepEqual(Array.from(HexInspector.parseNeedle("78 9c", "hex")), [0x78, 0x9c]);
  assert.deepEqual(Array.from(HexInspector.parseNeedle("789C", "hex")), [0x78, 0x9c]);
  assert.deepEqual(Array.from(HexInspector.parseNeedle("0x78 0x9c", "hex")), [0x78, 0x9c]);
  assert.equal(HexInspector.parseNeedle("789", "hex"), null);
  assert.equal(HexInspector.parseNeedle("zz", "hex"), null);
  assert.equal(HexInspector.parseNeedle("", "hex"), null);
  assert.deepEqual(Array.from(HexInspector.parseNeedle("a\u00e9", "text")), [0x61, 0xc3, 0xa9]);
  assert.equal(HexInspector.parseNeedle("", "text"), null);
});

test("find forward and backward", () => {
  const b = U8(1, 2, 3, 1, 2, 3, 1, 2);
  const n = U8(1, 2);
  assert.equal(HexInspector.find(b, n, 0), 0);
  assert.equal(HexInspector.find(b, n, 1), 3);
  assert.equal(HexInspector.find(b, n, 7), -1);
  assert.equal(HexInspector.find(b, U8(1, 2), 6), 6);
  assert.equal(HexInspector.find(b, U8(3), 0), 2);
  assert.equal(HexInspector.find(b, n, 6, { backward: true }), 3);
  assert.equal(HexInspector.find(b, n, 7, { backward: true }), 6);
  assert.equal(HexInspector.find(b, n, 3, { backward: true }), 0);
  assert.equal(HexInspector.find(b, n, 0, { backward: true }), -1);
  assert.equal(HexInspector.find(b, U8(9), 0), -1);
  assert.equal(HexInspector.find(b, new Uint8Array(0), 0), -1);
  assert.equal(HexInspector.find(b, new Uint8Array(20), 0), -1);
});

test("formatSelection", () => {
  const b = U8(0x78, 0x9c, 0x41, 0x00, 0xff);
  assert.equal(HexInspector.formatSelection(b, 0, 2, "hex"), "78 9c");
  assert.equal(HexInspector.formatSelection(b, 0, 2, "hex-compact"), "789c");
  assert.equal(HexInspector.formatSelection(b, 0, 2, "c"), "{ 0x78, 0x9c }");
  assert.equal(HexInspector.formatSelection(b, 0, 2, "base64"), "eJw=");
  assert.equal(HexInspector.formatSelection(b, 0, 2, "python"), 'bytes.fromhex("789c")');
  assert.equal(HexInspector.formatSelection(b, 0, 5, "ascii"), "x.A..");
});

test("formatSelection wraps C arrays at 12 per line", () => {
  const b = new Uint8Array(13).fill(0xab);
  const lines = HexInspector.formatSelection(b, 0, 13, "c").split("\n");
  assert.equal(lines[0], "{");
  assert.equal(lines[1].trim().split(", ").length, 12);
  assert.equal(lines[lines.length - 1], "}");
});

test("formatSelection empty ranges and clamping", () => {
  const b = U8(1, 2, 3);
  assert.equal(HexInspector.formatSelection(b, 2, 2, "hex"), "");
  assert.equal(HexInspector.formatSelection(b, 3, 1, "hex"), "");
  assert.equal(HexInspector.formatSelection(b, 1, 99, "hex"), "02 03");
  assert.equal(HexInspector.formatSelection(b, 5, 9, "hex"), "");
});
