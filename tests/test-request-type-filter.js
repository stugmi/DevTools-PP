// Behavioral tests for request type classification and the Fetch/XHR filter (request-capture.js).
// Run with `bun test tests/test-request-type-filter.js`. Loads the real source into a vm context.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "capture", "request-capture.js"),
  "utf8"
);
const { requestTypeFor, requestMatchesTypeFilter } = vm.runInContext(
  `${source}\n({ requestTypeFor, requestMatchesTypeFilter });`,
  vm.createContext({})
);

const entry = (resourceType, mimeType, url = "https://shop.example.com/api/items") => ({
  _record: { resourceType, request: { url }, response: { bodyMimeType: mimeType } },
});

// Every filter button, matched against one request the way the Network table does it.
const FILTERS = ["xhr", "doc", "js", "json", "media", "socket", "wasm", "other"];
const buttonsFor = (item) =>
  FILTERS.filter((filter) => requestMatchesTypeFilter(item, requestTypeFor(item), filter));

test("fetch and XHR calls are listed under Fetch/XHR whatever they return", () => {
  const calls = [
    entry("fetch", "application/json"),
    entry("xhr", "application/vnd.api+json"),
    entry("fetch", "text/plain"),
    entry("xhr", ""),
    entry("fetch", "text/html; charset=utf-8"),
    entry("xhr", "image/png"),
  ];
  for (const call of calls) {
    assert.ok(buttonsFor(call).includes("xhr"), call._record.response.bodyMimeType);
  }
});

test("the Type column and its own button are unchanged for those calls", () => {
  assert.deepEqual(buttonsFor(entry("fetch", "application/json")), ["xhr", "json"]);
  assert.deepEqual(buttonsFor(entry("fetch", "text/html")), ["xhr", "doc"]);
  assert.deepEqual(buttonsFor(entry("xhr", "text/plain")), ["xhr"]);
});

test("page navigations are documents, not Fetch/XHR", () => {
  assert.deepEqual(buttonsFor(entry("document", "text/html")), ["doc"]);
});

test("scripts, media, sockets and wasm stay out of Fetch/XHR", () => {
  assert.deepEqual(buttonsFor(entry("script", "text/javascript")), ["js"]);
  assert.deepEqual(buttonsFor(entry("image", "image/png")), ["media"]);
  assert.deepEqual(buttonsFor(entry("websocket", "")), ["socket"]);
  assert.deepEqual(buttonsFor(entry("other", "application/wasm")), ["wasm"]);
});

test("a JSON file that was not fetched is not a Fetch/XHR match", () => {
  const file = entry("other", "application/json", "https://shop.example.com/a.json");
  assert.deepEqual(buttonsFor(file), ["other"]);
});

test("the resource type may come from the HAR entry when the record has none", () => {
  const harEntry = { _request: { _resourceType: "Fetch" }, _record: { request: { url: "/x" } } };
  assert.equal(requestMatchesTypeFilter(harEntry, requestTypeFor(harEntry), "xhr"), true);
});
