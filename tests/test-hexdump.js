// Behavioral tests for the byte-first body extraction helper (src/panel/js/lib/hexdump.js).
// Run with `node --test tests/test-hexdump.js`. The helper is a classic script that defines a
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

test("gRPC-web text bodies are base64 text, binary gRPC media still prefers hex", () => {
  const textBody = (contentType, raw) =>
    HexDump.requestBody(
      entry(
        { headers: [{ name: "Content-Type", value: contentType }], bodySize: raw.length },
        {
          _rawRequestBody: raw,
        }
      )
    );
  for (const type of ["application/grpc-web-text", "application/grpc-web-text+proto"]) {
    const r = textBody(type, "AAAAAAA=");
    assert.equal(r.text, "AAAAAAA=", type);
    assert.equal(HexDump.prefersHex(r), false, type);
  }
  const binary = HexDump.requestBody(
    entry(
      { headers: [{ name: "Content-Type", value: "application/grpc-web+proto" }] },
      { _requestBodyBytes: { base64: "AAAAAAA=", source: "t" } }
    )
  );
  assert.equal(HexDump.prefersHex(binary), true);
});

test("decodeBase64Text decodes whole-body base64, including gRPC-web chunks", () => {
  const decode = (text) => {
    const bytes = HexDump.decodeBase64Text(text);
    return bytes && Array.from(bytes);
  };
  assert.deepEqual(decode("AAAAAAA="), [0, 0, 0, 0, 0]);
  // Two padded gRPC-web frames concatenated: an empty data frame and an empty trailer frame.
  assert.deepEqual(decode("AAAAAAA=" + "gAAAAAA="), [0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0]);
  assert.deepEqual(decode("_-8"), null, "too short");
  assert.deepEqual(decode("__-_"), [0xff, 0xff, 0xbf], "URL-safe alphabet");
  assert.deepEqual(decode("eJwA/w"), [0x78, 0x9c, 0x00, 0xff], "unpadded final chunk");
  for (const bad of ["not base64!", "abcde", "ab+_cd==", "AA==AA=x", ""]) {
    assert.equal(HexDump.decodeBase64Text(bad), null, JSON.stringify(bad));
  }
});
