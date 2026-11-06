// Table-driven tests for sniffBodyLang (src/panel/js/network/request-body.js).
// Run with `node --test scripts/test-sniff-body-lang.js`. The panel script is a classic script
// with globals, so it is evaluated in a vm context with the few helpers it needs stubbed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "network", "request-body.js"),
  "utf8"
);
const context = vm.createContext({
  baseMime: (mime) => (mime || "").split(";")[0].trim().toLowerCase(),
  parseJsonExact: JSON.parse,
  stringifyJsonExact: JSON.stringify,
  langFromContentType: () => null,
  formatJsonText: (text) => text,
  tryPretty: () => ({ ok: false }),
});
vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "..", "src", "panel", "js", "lib", "json-payload.js"),
    "utf8"
  ),
  context
);
const sniffBodyLang = vm.runInContext(`${source}\nsniffBodyLang`, context);

const flight = '0:{"buildId":"x"}\n1:"$Sreact.fragment"\n';
const cases = [
  // [name, body, mime, expected]
  ["time-like text", "12:30 meeting", undefined, null],
  ["tiny pair", "1:2", undefined, null],
  ["key:number", "a:5", undefined, null],
  ["single flight-looking line", '0:{"a":1}', undefined, null],
  ["flight lines", flight, undefined, "javascript"],
  ["JSON text", '{"a":1}', "text/plain", "json"],
  ["JSON array text", "[1, 2]", undefined, "json"],
  ["newline-delimited JSON records", '{"a":1}\n{"b":[2]}', "text/plain", "json"],
  ["records with CRLF and trailing newline", '{"a":1}\r\n{"b":2}\r\n', undefined, "json"],
  ["truncated last record", '{"a":1}\n{"b":', "text/plain", null],
  ["record then prose", '{"a":1}\nplain text', undefined, null],
  ["JSON-looking lines mixed with a scalar", '{"a":1}\n2', undefined, null],
  ["invalid JSON", "{nope", undefined, null],
  ["JS without MIME", 'import x from "y";', undefined, "javascript"],
  ["JS with application MIME", "const a = 1;", "application/octet-stream", "javascript"],
  ["prose with text MIME", "import the files first", "text/plain", null],
  ["CSS comment with text MIME", "/* reset */ body {}", "text/plain", null],
  ["doctype html", "<!doctype html><html></html>", undefined, "html"],
  ["comment then doctype", "<!-- c -->\n<!DOCTYPE html><html></html>", undefined, "html"],
  ["html fragment", "<div class=x>hi</div>", undefined, "html"],
  ["xml declaration", '<?xml version="1.0"?><a/>', undefined, "xml"],
  ["comment then xml", '<!-- c --><?xml version="1.0"?><a/>', undefined, "xml"],
  ["svg root", '<svg xmlns="http://www.w3.org/2000/svg"></svg>', undefined, "xml"],
  ["blank", "   ", undefined, null],
  ["plain text", "hello world", undefined, null],
  ["structured JSON object", { a: 1 }, "application/json", "json"],
  ["base64 object", { encoding: "base64", data: "AAAA" }, "image/png", "plaintext"],
  ["form object", { a: "1" }, "application/x-www-form-urlencoded", "plaintext"],
  ["undefined body", undefined, undefined, null],
];

for (const [name, body, mime, expected] of cases) {
  test(`sniffBodyLang: ${name}`, () => {
    assert.equal(sniffBodyLang(body, mime), expected);
  });
}
