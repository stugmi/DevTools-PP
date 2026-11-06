// Behavioral tests for the pure hex dump helper (src/panel/js/lib/hexdump.js).
// Run with `node --test scripts/test-hexdump.js`. The helper is a classic script that defines a
// top-level `HexDump` const, so it is evaluated in a vm context (no DOM needed).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// request-code.js loads first: HexDump.requestBody delegates to RequestCode.requestBody.
const context = vm.createContext({
  TextDecoder,
  TextEncoder,
  atob,
  btoa,
  Uint8Array,
  URLSearchParams,
});
const libSource = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "src", "panel", "js", "lib", name), "utf8");
vm.runInContext(libSource("request-code.js"), context);
const HexDump = vm.runInContext(`${libSource("hexdump.js")}\nHexDump`, context);

// Parse a dump row into its visible parts, independent of exact spacing.
function parseRow(row) {
  const m = /^([0-9a-f]+)\s+((?:[0-9a-f]{2}\s*)*)\|(.*)\|$/.exec(row);
  assert.ok(m, `row does not look like a hex row: ${JSON.stringify(row)}`);
  const hex = m[2].trim() === "" ? [] : m[2].trim().split(/\s+/);
  return { offset: parseInt(m[1], 16), hex, ascii: m[3], pipeAt: row.indexOf("|") };
}

const rowsOf = (bytes, opts) => HexDump.formatRows(bytes, opts).split("\n").map(parseRow);
const hex2 = (b) => b.toString(16).padStart(2, "0");

test("known bytes: offsets, hex, ascii, partial last row", () => {
  const text = "0123456789abcdefXYZ";
  const bytes = Uint8Array.from(Buffer.from(text, "latin1"));
  const rows = rowsOf(bytes);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].offset, 0);
  assert.deepEqual(rows[0].hex, [...bytes.slice(0, 16)].map(hex2));
  assert.equal(rows[0].ascii, "0123456789abcdef");
  assert.equal(rows[1].offset, 16);
  assert.deepEqual(rows[1].hex, ["58", "59", "5a"]);
  assert.equal(rows[1].ascii, "XYZ");
});

test("partial row hex is padded so the ascii column stays aligned", () => {
  const rows = rowsOf(Uint8Array.from({ length: 21 }, (_, i) => 0x41 + i));
  assert.equal(rows[0].pipeAt, rows[1].pipeAt);
});

test("midpoint gap sits after the 8th byte", () => {
  const line = HexDump.formatRows(Uint8Array.from({ length: 16 }, (_, i) => i));
  const gap = /(?:^|\s)07\s{2,}08(?:\s|$)/;
  assert.match(line, gap);
  assert.doesNotMatch(line, /(?:^|\s)06\s{2,}07/);
});

test("non-printable and non-ascii bytes render as dots", () => {
  const rows = rowsOf(Uint8Array.of(0x78, 0x9c, 0x00, 0xff, 0xfe, 0x80, 0x41, 0x7f, 0x20, 0x7e));
  assert.deepEqual(rows[0].hex, ["78", "9c", "00", "ff", "fe", "80", "41", "7f", "20", "7e"]);
  assert.equal(rows[0].ascii, "x.....A. ~");
});

test("invalid utf-8 sequence is dumped byte for byte", () => {
  const rows = rowsOf(Uint8Array.of(0xc3, 0x28, 0xe2, 0x82));
  assert.deepEqual(rows[0].hex, ["c3", "28", "e2", "82"]);
  assert.equal(rows[0].ascii, ".(..");
});

test("empty input yields an empty dump", () => {
  assert.equal(HexDump.formatRows(new Uint8Array(0)), "");
  const d = HexDump.dump(new Uint8Array(0));
  assert.equal(d.text, "");
  assert.equal(d.total, 0);
  assert.equal(d.pages, 1);
  assert.equal(d.end, 0);
});

test("exactly one full row has no second row", () => {
  const rows = rowsOf(new Uint8Array(16).fill(0x61));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hex.length, 16);
});

test("large input: contiguous offsets, no duplicates, bytes round-trip", () => {
  const n = 16 * 300 + 5;
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
  const rows = rowsOf(bytes);
  assert.equal(rows.length, 301);
  const back = [];
  rows.forEach((row, i) => {
    assert.equal(row.offset, i * 16);
    assert.equal(row.hex.length, i < 300 ? 16 : 5);
    for (const h of row.hex) back.push(parseInt(h, 16));
  });
  assert.deepEqual(Uint8Array.from(back), bytes);
});

test("start/end window dumps only that range with real offsets", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const rows = rowsOf(bytes, { start: 32, end: 50 });
  assert.deepEqual(
    rows.map((r) => r.offset),
    [32, 48]
  );
  assert.deepEqual(
    rows[0].hex,
    Array.from({ length: 16 }, (_, i) => hex2(32 + i))
  );
  assert.deepEqual(rows[1].hex, ["30", "31"]);
});

test("dump pages keep absolute offsets and a stable offset width", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const p0 = HexDump.dump(bytes, 0, 48);
  const p2 = HexDump.dump(bytes, 2, 48);
  assert.equal(p0.pages, 3);
  assert.equal(p0.total, 100);
  assert.deepEqual([p0.start, p0.end], [0, 48]);
  assert.deepEqual([p2.start, p2.end], [96, 100]);
  const r0 = p0.text.split("\n").map(parseRow);
  const r2 = p2.text.split("\n").map(parseRow);
  assert.deepEqual(
    r0.map((r) => r.offset),
    [0, 16, 32]
  );
  assert.deepEqual(
    r2.map((r) => r.offset),
    [96]
  );
  assert.deepEqual(r2[0].hex, ["60", "61", "62", "63"]);
  assert.equal(p0.text.indexOf("|"), p2.text.indexOf("|"));
});

test("dump clamps out-of-range pages", () => {
  const bytes = new Uint8Array(100).fill(0x62);
  assert.equal(HexDump.dump(bytes, 99, 40).page, 2);
  assert.equal(HexDump.dump(bytes, -5, 40).page, 0);
  const whole = HexDump.dump(bytes);
  assert.equal(whole.pages, 1);
  assert.equal(whole.end, 100);
});

test("fromBase64 decodes valid input and rejects invalid", () => {
  assert.deepEqual(HexDump.fromBase64("eJwAAP8="), Uint8Array.of(0x78, 0x9c, 0, 0, 0xff));
  assert.equal(HexDump.fromBase64("***not base64***"), null);
});

// Minimal captured entry as the panel builds it: display record plus raw-body side fields.
function entry(request = {}, extra = {}) {
  return {
    _record: { request: { url: "https://example.test/", headers: [], ...request } },
    ...extra,
  };
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("request body: exact captured bytes are binary and prefer hex", () => {
  const raw = Uint8Array.of(0x78, 0x9c, 0x00, 0xff, 0xfe);
  const r = HexDump.requestBody(
    entry({}, { _requestBodyBytes: { base64: b64(raw), source: "t" } })
  );
  assert.equal(r.status, "bytes");
  assert.equal(r.binary, true);
  assert.deepEqual(Uint8Array.from(r.bytes), raw);
  assert.equal(HexDump.prefersHex(r), true);
});

test("request body: exact utf-8 text bytes are decoded and do not prefer hex", () => {
  const raw = Buffer.from('{"a":"caf\u00e9"}', "utf8");
  const r = HexDump.requestBody(
    entry({}, { _requestBodyBytes: { base64: b64(raw), source: "t" } })
  );
  assert.equal(r.status, "bytes");
  assert.equal(r.text, '{"a":"caf\u00e9"}');
  assert.equal(HexDump.prefersHex(r), false);
});

test("request body: legacy base64 raw body gives exact bytes", () => {
  const raw = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00, 0xff);
  const r = HexDump.requestBody(entry({ bodyEncoding: "base64" }, { _rawRequestBody: b64(raw) }));
  assert.equal(r.status, "bytes");
  assert.deepEqual(Uint8Array.from(r.bytes), raw);
});

test("request body: empty captured bytes differ from missing bytes", () => {
  const empty = HexDump.requestBody(entry({}, { _requestBodyBytes: { base64: "", source: "t" } }));
  assert.equal(empty.status, "empty");
  const absent = HexDump.requestBody(entry({ bodySize: 0 }));
  assert.equal(absent.status, "absent");
  assert.equal(HexDump.prefersHex(absent), false);
});

test("request body: lossy text copy is never presented as original bytes", () => {
  for (const bad of ["x\ufffdy", "lone\ud800surrogate"]) {
    const r = HexDump.requestBody(entry({ bodySize: bad.length }, { _rawRequestBody: bad }));
    assert.equal(r.status, "unavailable", JSON.stringify(bad));
    assert.equal(r.bytes, undefined);
    assert.ok(r.reason);
  }
});

test("request body: clean text is encoded as utf-8", () => {
  const r = HexDump.requestBody(entry({ bodySize: 5 }, { _rawRequestBody: "hello" }));
  assert.equal(r.status, "bytes");
  assert.deepEqual(Uint8Array.from(r.bytes), Uint8Array.from(Buffer.from("hello")));
});

test("request body: a parsed display body is never treated as original bytes", () => {
  // A parsed JSON body may coincidentally carry encoding/data keys.
  const parsed = { encoding: "base64", data: b64(Uint8Array.of(1, 2, 3)) };
  const r = HexDump.requestBody(entry({ bodySize: 40, body: parsed }));
  assert.notEqual(r.status, "bytes");
  assert.equal(r.bytes, undefined);
});

test("response body: base64 cache is exact bytes; lossy text is unavailable", () => {
  const raw = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00);
  const ok = HexDump.responseBody({
    _record: { response: { headers: [], bodyEncoding: "base64" } },
    _rawResponseBody: b64(raw),
  });
  assert.equal(ok.status, "bytes");
  assert.deepEqual(Uint8Array.from(ok.bytes), raw);
  const bad = HexDump.responseBody({
    _record: { response: { headers: [] } },
    _rawResponseBody: "a\ufffdb",
  });
  assert.equal(bad.status, "unavailable");
  assert.equal(bad.bytes, undefined);
  assert.equal(HexDump.responseBody({ _record: { response: { headers: [] } } }).status, "absent");
});
