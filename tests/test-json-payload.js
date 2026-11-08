// Behavioral tests for JSON payload handling: a single JSON value or newline-delimited JSON
// records (the Datadog browser SDK's RUM batch framing) through detection, the Source pretty view
// and the Parsed value. Run with `bun test tests/test-json-payload.js`.
// The panel scripts are classic scripts sharing one global scope, so the real ones are loaded
// into one vm context in page order.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const jsRoot = path.join(__dirname, "..", "src", "panel", "js");
const context = vm.createContext({ window: {} });
for (const file of [
  "lib/code-format.js",
  "lib/filetype.js",
  "capture/request-capture.js",
  "lib/json-payload.js",
  "network/request-body.js",
]) {
  vm.runInContext(fs.readFileSync(path.join(jsRoot, file), "utf8"), context, { filename: file });
}
const api = vm.runInContext(
  `({ parseJsonPayload, formatJsonPayloadText, sniffBody, formatBodyText, parseBody,
      bodyLanguageFor, parsedBodyFor, formattedBodyFor, stringifyJsonExact })`,
  context
);

// Objects built inside the vm have another realm's prototypes, so compare through JSON text.
const jsonOf = (value) => api.stringifyJsonExact(value);
const plain = (value) => JSON.parse(JSON.stringify(value));

// A browser SDK batch: compact JSON events joined by "\n", no trailing newline.
const events = [
  {
    date: 1762400000123,
    type: "resource",
    application: { id: "a1b2c3d4-0000-4000-8000-000000000001" },
    view: { id: "v1", url: "https://github.com/owner/repo?q=%22x%22" },
    resource: {
      type: "fetch",
      url: "https://api.github.com/x",
      duration: 12345678,
      status_code: 200,
    },
    _dd: { format_version: 2, document_version: 3 },
  },
  {
    date: 1762400000456,
    type: "action",
    action: { id: "act", type: "click", target: { name: "Caf\u00e9 \u2603 {not a brace}" } },
    context: { tags: [], nested: {} },
  },
  { date: 1762400000789, type: "view", view: { id: "v1", time_spent: 0, is_active: true } },
];
const batch = events.map((event) => JSON.stringify(event)).join("\n");
const TEXT_PLAIN = "text/plain;charset=UTF-8";

function payloadEntry(body, mime, override = "auto") {
  return {
    _record: { request: { body, bodyMimeType: mime }, response: {} },
    _bodyLang: { payload: override, response: "auto" },
  };
}

// Splits a formatted record view back into its records, checking each is indented and valid.
function recordsOfView(text) {
  assert.ok(text.endsWith("\n"));
  return text
    .slice(0, -1)
    .split("\n\n")
    .map((block) => {
      assert.ok(block.includes("\n  "), "record is indented");
      return JSON.parse(block);
    });
}

test("batch payload is detected as JSON when the MIME type says nothing", () => {
  for (const mime of [TEXT_PLAIN, undefined, "application/octet-stream"]) {
    const sniffed = api.sniffBody(batch, mime);
    assert.equal(sniffed.lang, "json");
    assert.equal(jsonOf(sniffed.json), JSON.stringify(events));
  }
});

test("auto mode parses and pretty-prints the batch, keeping one view per record in order", () => {
  const entry = payloadEntry(batch, TEXT_PLAIN);
  const { lang, forced } = api.bodyLanguageFor(entry, "payload");
  assert.equal(lang, "json");
  assert.equal(forced, false);

  const parsed = api.parsedBodyFor(entry, "payload");
  assert.equal(parsed.kind, "json");
  assert.equal(jsonOf(parsed.value), JSON.stringify(events));

  const shown = api.formattedBodyFor(entry, "payload", batch, lang, TEXT_PLAIN, forced);
  assert.equal(shown.lang, "json");
  assert.deepEqual(recordsOfView(shown.text), events);
});

test("manual JSON mode formats and parses the batch", () => {
  const entry = payloadEntry(batch, TEXT_PLAIN, "json");
  const { lang, forced } = api.bodyLanguageFor(entry, "payload");
  assert.deepEqual([lang, forced], ["json", true]);
  const shown = api.formatBodyText(batch, lang, TEXT_PLAIN, forced);
  assert.deepEqual(recordsOfView(shown.text), events);
  assert.equal(jsonOf(api.parsedBodyFor(entry, "payload").value), JSON.stringify(events));
});

test("manual overrides other than JSON still win", () => {
  const entry = payloadEntry(batch, TEXT_PLAIN, "plaintext");
  const { lang, forced } = api.bodyLanguageFor(entry, "payload");
  assert.deepEqual(plain(api.formatBodyText(batch, lang, TEXT_PLAIN, forced)), {
    text: batch,
    lang,
  });
  assert.equal(api.parsedBodyFor(entry, "payload"), null);
});

test("records misdeclared as application/json still format", () => {
  const shown = api.formatBodyText(batch, "json", "application/json", false);
  assert.deepEqual(recordsOfView(shown.text), events);
});

test("blank lines, CRLF and a trailing newline between records are tolerated", () => {
  const body = events.map((event) => JSON.stringify(event)).join("\r\n\r\n") + "\r\n";
  const result = api.parseJsonPayload(body);
  assert.equal(jsonOf(result.value), JSON.stringify(events));
  assert.equal(result.records.length, events.length);
  assert.deepEqual(recordsOfView(api.formatJsonPayloadText(body)), events);
});

test("an ordinary JSON value is not treated as records", () => {
  for (const body of ['{"a":1}', '{"a":1}\n', "[1, 2]"]) {
    const result = api.parseJsonPayload(body);
    assert.equal(result.records, null);
    assert.equal(jsonOf(result.value), JSON.stringify(JSON.parse(body)));
  }
});

test("pretty multi-line JSON stays one value", () => {
  const body = JSON.stringify({ a: [1, { b: 2 }], c: { d: "e" } }, null, 4);
  const result = api.parseJsonPayload(body);
  assert.equal(result.records, null);
  assert.equal(jsonOf(result.value), JSON.stringify({ a: [1, { b: 2 }], c: { d: "e" } }));
  assert.equal(
    api.formatJsonPayloadText(body),
    JSON.stringify({ a: [1, { b: 2 }], c: { d: "e" } }, null, 2) + "\n"
  );
});

test("a pretty-printed sequence is not newline-delimited records", () => {
  const body = JSON.stringify({ a: 1 }, null, 2) + "\n" + JSON.stringify({ b: 2 }, null, 2);
  assert.equal(api.parseJsonPayload(body), null);
  assert.throws(() => api.formatJsonPayloadText(body));
  assert.equal(api.sniffBody(body, TEXT_PLAIN).lang, null);
});

test("integers beyond 2^53 stay exact in records and single values", () => {
  const body = '{"id":9007199254740993,"ok":1}\n{"ids":[12345678901234567890],"f":1.5}';
  const result = api.parseJsonPayload(body);
  assert.equal(result.value[0].id, 9007199254740993n);
  assert.equal(result.value[1].ids[0], 12345678901234567890n);
  assert.equal(result.value[0].ok, 1);
  const view = api.formatJsonPayloadText(body);
  assert.ok(view.includes("9007199254740993") && view.includes("12345678901234567890"));
  assert.equal(
    jsonOf(result.value),
    `[{"id":9007199254740993,"ok":1},{"ids":[12345678901234567890],"f":1.5}]`
  );

  const single = api.parseJsonPayload('{"id":9007199254740993}');
  assert.equal(single.value.id, 9007199254740993n);
});

test("escaped quotes, escaped newlines and brace characters stay inside their record", () => {
  const first = { m: 'say "hi"\nthen {leave}\\', k: "\u2028 raw separator" };
  const second = { m: '}\n{"fake":true}' };
  const body = JSON.stringify(first) + "\n" + JSON.stringify(second);
  assert.equal(body.split("\n").length, 2);
  const result = api.parseJsonPayload(body);
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].m, first.m);
  assert.equal(result.value[0].k, first.k);
  assert.equal(result.value[1].m, second.m);
  assert.deepEqual(recordsOfView(api.formatJsonPayloadText(body)), [first, second]);
});

test("a truncated or malformed record rejects the whole payload", () => {
  const bad = [
    batch.slice(0, -5),
    batch.replace('"type":"action"', '"type":"action'),
    '{"a":1}\n{"b":2,}',
    '{"a":1},\n{"b":2}',
    '{"a":1}\n{"b":2}\n{"c"',
    '{"a":1}\n{"b":2}\ngarbage',
    '{"a":1}\n2',
    '{"a":1}\n"text"',
  ];
  for (const body of bad) {
    assert.equal(api.parseJsonPayload(body), null, body);
    assert.throws(() => api.formatJsonPayloadText(body));
    assert.equal(api.sniffBody(body, TEXT_PLAIN).lang, null, body);
    // A manual JSON override leaves text it cannot format untouched.
    const unchanged = api.formatBodyText(body, "json", TEXT_PLAIN, true);
    assert.deepEqual(plain(unchanged), { text: body, lang: "json" });
    assert.equal(api.parseBody(body, "json"), null, body);
  }
});

test("text that only looks line-oriented keeps its classification", () => {
  const flight = '0:{"buildId":"x"}\n1:"$Sreact.fragment"\n';
  const cases = [
    ["numbers per line", "1\n2\n3", null],
    ["prose", "hello\nworld", null],
    ["unquoted-key objects", "{ a: 1 }\n{ b: 2 }", null],
    ["JS calls on brackets", "[1, 2].map(String)\n[3]", null],
    ["flight with JSON values", flight, "javascript"],
    ["JS module", 'import x from "y";\nexport default {};', "javascript"],
    ["JS with a JSON-looking first line", '{"a":1}\nconst b = 2;', null],
  ];
  for (const [name, body, lang] of cases) {
    assert.equal(api.parseJsonPayload(body), null, name);
    assert.equal(api.sniffBody(body, undefined).lang, lang, name);
  }
});

test("flight text is never reformatted as JSON", () => {
  const flight = '0:{"buildId":"x"}\n1:"$Sreact.fragment"\n';
  const shown = api.formatBodyText(flight, "javascript", "text/x-component", false);
  assert.deepEqual(plain(shown), { text: flight, lang: "javascript" });
});
