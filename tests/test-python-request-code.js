// Tests Python replay syntax, formatting, and wire bytes with real requests/httpx clients.
// Run with `bun test tests/test-python-request-code.js`. Native cases skip if unavailable;
// set PYTHON_REQUEST_CODE_PYTHON to select an interpreter.

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "lib", "request-code.js"),
  "utf8"
);
const libContext = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, URLSearchParams });
const RequestCode = vm.runInContext(`${source}\nRequestCode`, libContext);

// Copy as has one Python format; the pythonLibrary option picks the package.
const LIBS = [
  { name: "python (requests)", module: "requests" },
  { name: "python (httpx)", module: "httpx" },
];

function serializeFor(lib, entries, options = {}) {
  return RequestCode.serialize("python", entries, { ...options, pythonLibrary: lib.module });
}

// -- Fixtures --

function entry(request = {}, extra = {}) {
  return {
    _record: {
      request: {
        url: "https://example.test/",
        method: "GET",
        headers: [],
        cookies: [],
        bodySize: 0,
        ...request,
      },
    },
    ...extra,
  };
}

function headerList(pairs) {
  return pairs.map(([name, value]) => ({ name, value }));
}

// A captured request whose body is `bytes`, delivered either as UTF-8 text or as base64.
function bodyEntry(c, base) {
  const bytes = c.bytes;
  const mime = c.mime;
  const stale = [
    ["Content-Length", "999999"],
    [":authority", "example.test"],
    ["Transfer-Encoding", "chunked"],
  ];
  const headers = [
    ["X-Case", String(c.index)],
    ...(mime && !c.noContentTypeHeader ? [["Content-Type", mime]] : []),
    ...(c.headers || []),
    ...(c.stale === false ? [] : stale),
  ];
  const request = {
    url: base + c.path,
    method: c.method || "POST",
    headers: headerList(headers),
    bodySize: bytes.length,
    bodyMimeType: c.headerOnlyMime ? undefined : mime,
  };
  if (c.explicitBytes) {
    // Lossy raw text must be ignored when the capture exposes the exact original bytes.
    return entry(request, {
      _rawRequestBody: c.lossyText,
      _requestBodyBytes: { base64: bytes.toString("base64"), source: "postDataEntries" },
    });
  }
  if (c.mode === "base64") {
    request.bodyEncoding = "base64";
    return entry(request, { _rawRequestBody: bytes.toString("base64") });
  }
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text, "utf8").equals(bytes), "fixture " + c.name + " must be valid UTF-8");
  return entry(request, { _rawRequestBody: text });
}

const JSON_NONCANONICAL =
  '{ "id" : 12345678901234567890 ,\n  "big":-9007199254740993, "price":1.10, "exp":1E+2, ' +
  '"neg0":-0.0, "tiny":0.1000000000000000055511151231257827,\n "huge":1e999, "nan":NaN, ' +
  '"nested":{"a":[1,2,{"b":null,"c":[[],{}]}],"s":"caf\\u00e9 raw:\u00e9 \ud83d\ude00 ' +
  '\\ud83d\\ude00 \\/ \\\\ \\"q\\""},"dup":1,"dup":2 }\n';

const URLENCODED_ODD = "b=2&a=1&a=&=x&c&&d=%7e+%2B%20&e=%e9&a=3&%41=%61&empty=&";
const URLENCODED_LONG = Array.from({ length: 140 }, (_, i) => {
  const odd = ["a=", "b", "", "a=%2F%2f", "k=v+w", "%7e=%7E"][i % 6];
  return `${odd}${i % 6 === 2 ? "" : "&"}dup=${i}&k${i % 7}=v%3d${i}`;
}).join("&");

const QUOTE_SOUP =
  `"""triple""" '''single''' \\n \\x41 \\u00e9 {} {0} %s %(a)s \${x} #c \`\` \\\\\n` +
  `back\\` +
  "\r\nrow2\u2028row3\u0085 end \\";

const CONTROL_TEXT = "a\u0000b\r\n\t\u001b\u007f\u0085\u2028\u2029\u000b\u000c end\r\n";
const UNICODE_TEXT =
  '{"msg":"h\u00e9llo w\u00f6rld \u65e5\u672c\u8a9e \ud83d\ude00 \ud83c\udde9\ud83c\uddea"}';
const BOUNDARY = "----WebKitFormBoundaryAbC123xyZ";

const MULTIPART_BINARY = Buffer.concat([
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue \u00e9\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n"
  ),
  Buffer.from([0, 255, 254, 128, 13, 10, 45, 45, 0x78, 0x9c, 0, 1]),
  Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
]);
const MULTIPART_TEXT = Buffer.from(
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n` +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\n\r\n--${BOUNDARY}--\r\n`
);

const INVALID_UTF8 = Buffer.from([0x78, 0x9c, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x01]);
const ALL_BYTES_LONG = Buffer.alloc(256 * 20 + 3);
for (let i = 0; i < ALL_BYTES_LONG.length; i++) ALL_BYTES_LONG[i] = i & 0xff;
const GZIPPED = zlib.gzipSync(Buffer.from(JSON_NONCANONICAL.repeat(30)));

// JSON bodies sent with a non-JSON Content-Type (as GitHub's collector does). `payload` marks the
// ones json.dumps reproduces exactly; the rest must keep the raw-text replay. `walrus` marks the
// ones whose JSON-text string values go through the stringify(...) helper.
const COLLECTOR_JSON = JSON.stringify({
  client_id: "1234567890.1730000000",
  events: [
    {
      entries: JSON.stringify([
        { name: "index-JVHuKBxQ.css", cached: false, duration: 51.1, size: 18342 },
        { name: "caf\u00e9-\ud83d\ude00.js", cached: true, initiator: null, sizes: [] },
      ]),
      context: JSON.stringify({ react: true, meta: JSON.stringify({ depth: 2, ids: [1] }) }),
      spaced: '{"a": 1}',
      escaped: '["caf\\u00e9"]',
      scalars: ["false", "5651832", "null", '"q"', "[]x", "{}"],
      // Python spellings differ from JavaScript: 1e-7 is rejected everywhere (Python writes
      // 1e-07); 1.0 and integers beyond 2^53 are exact in Python only.
      numbers: ["[1e-7]", "[1.0]", "[12345678901234567890]"],
      quote: 'it\'s "q" \\ \n\t',
      timestamp: 1730000000123,
      dimensions: { visible: true, scroll: 0.75, tags: ["a", "b"], nothing: null, nested: [] },
    },
  ],
  request_context: { referrer: "", browser_width: 1568, empty: {} },
});
const JSON_TEXT_CASES = [
  {
    name: "collector JSON as text/plain",
    text: COLLECTOR_JSON,
    payload: true,
    walrus: true,
  },
  {
    name: "JSON as text/plain, nested JSON with default outer spacing",
    text: '{"a": "[1,{\\"b\\":2}]", "c": "[1, 2]"}',
    payload: true,
  },
  {
    name: "JSON as text/plain, literal non-ASCII",
    text: '{"q":"caf\u00e9 \ud83d\ude00"}',
    payload: true,
  },
  {
    name: "JSON as text/plain, ASCII escapes",
    text: '{"q": "caf\\u00e9", "n": [1, 2]}',
    payload: true,
  },
  { name: "JSON array as text/plain", text: '[{"a":1},"b",-2.5,false]', payload: true },
  {
    // Browsers send shortest round-trip floats such as devicePixelRatio 0.8999999761581421.
    name: "JSON as text/plain, 16-17 digit floats",
    text: '{"pixel_ratio":0.8999999761581421,"x":0.30000000000000004,"t":1794083135698.5,"w":1.0}',
    payload: true,
  },
  {
    name: "JSON as text/plain, float with a non-shortest spelling",
    text: '{"a":0.10000000000000000555}',
    payload: false,
  },
  { name: "JSON as text/plain, float with a trailing zero", text: '{"a":1.50}', payload: false },
  { name: "JSON as text/plain, float below 1e-4", text: '{"a":0.00001}', payload: false },
  {
    name: "JSON as text/plain, Python-only big int",
    text: '{"n":12345678901234567890}',
    payload: true,
  },
  { name: "JSON as text/plain, irregular spaces", text: '{"a": 1,"b":2}', payload: false },
  {
    name: "JSON as text/plain, mixed escapes",
    text: '{"a":"\u00e9","b":"\\u00e9"}',
    payload: false,
  },
  { name: "JSON as text/plain, escaped slash", text: '{"a":"\\/"}', payload: false },
  { name: "JSON as text/plain, duplicate keys", text: '{"a":1,"a":2}', payload: false },
  { name: "JSON as text/plain, exponent", text: '{"a":1E+2}', payload: false },
  {
    name: "JSON as text/plain, 70-digit int",
    text: '{"a":' + "9".repeat(70) + "}",
    payload: false,
  },
  { name: "JSON as text/plain, trailing newline", text: '{"a":1}\n', payload: false },
].map((c) => ({ ...c, bytes: Buffer.from(c.text), mime: "text/plain;charset=UTF-8" }));
// JSON-typed bodies with nested JSON text: json=payload for the library whose spacing matches.
JSON_TEXT_CASES.push(
  ...['{"a":"[1,{\\"b\\":2}]"}', '{"a": "[1,{\\"b\\":2}]"}'].map((text) => ({
    name: "nested JSON text in application/json: " + text,
    text,
    bytes: Buffer.from(text),
    mime: "application/json",
  }))
);

const BODY_CASES = [
  {
    name: "noncanonical nested JSON (text)",
    bytes: Buffer.from(JSON_NONCANONICAL),
    mime: "application/json",
    method: "PUT",
  },
  {
    name: "noncanonical nested JSON (base64)",
    bytes: Buffer.from(JSON_NONCANONICAL),
    mime: "application/json",
    mode: "base64",
  },
  {
    name: "canonical compact JSON",
    bytes: Buffer.from('{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}'),
    mime: "application/json",
  },
  { name: "JSON with BOM", bytes: Buffer.from("\ufeff" + '{"a":1}'), mime: "application/json" },
  {
    name: "canonical urlencoded",
    bytes: Buffer.from("a=1&b=2&c=x+y"),
    mime: "application/x-www-form-urlencoded",
  },
  {
    name: "noncanonical urlencoded duplicates/empties (text)",
    bytes: Buffer.from(URLENCODED_ODD),
    mime: "application/x-www-form-urlencoded; charset=UTF-8",
  },
  {
    name: "noncanonical urlencoded duplicates/empties (base64)",
    bytes: Buffer.from(URLENCODED_ODD),
    mime: "application/x-www-form-urlencoded",
    mode: "base64",
  },
  {
    name: "long urlencoded",
    bytes: Buffer.from(URLENCODED_LONG),
    mime: "application/x-www-form-urlencoded",
    method: "PATCH",
  },
  { name: "ASCII text", bytes: Buffer.from("plain ascii body"), mime: "text/plain" },
  {
    name: "Unicode JSON keeps UTF-8 length",
    bytes: Buffer.from(UNICODE_TEXT),
    mime: "application/json; charset=utf-8",
  },
  {
    name: "quotes, backslashes and format characters",
    bytes: Buffer.from(QUOTE_SOUP),
    mime: "text/plain",
  },
  {
    name: "NUL and control characters (text)",
    bytes: Buffer.from(CONTROL_TEXT),
    mime: "text/plain",
  },
  {
    name: "NUL and control characters (base64)",
    bytes: Buffer.from(CONTROL_TEXT),
    mime: "text/plain",
    mode: "base64",
  },
  {
    name: "invalid UTF-8 / zlib-looking bytes",
    bytes: INVALID_UTF8,
    mime: "application/octet-stream",
    mode: "base64",
  },
  {
    name: "all byte values, long",
    bytes: ALL_BYTES_LONG,
    mime: "application/octet-stream",
    mode: "base64",
  },
  {
    name: "gzip body with Content-Encoding",
    bytes: GZIPPED,
    mime: "application/json",
    mode: "base64",
    headers: [["Content-Encoding", "gzip"]],
  },
  {
    name: "deflate and raw bytes",
    bytes: zlib.deflateRawSync(Buffer.from("deflate me ".repeat(50))),
    mime: "application/octet-stream",
    mode: "base64",
  },
  {
    name: "multipart with binary part",
    bytes: MULTIPART_BINARY,
    mime: `multipart/form-data; boundary=${BOUNDARY}`,
    mode: "base64",
  },
  {
    name: "multipart text only",
    bytes: MULTIPART_TEXT,
    mime: `multipart/form-data; boundary=${BOUNDARY}`,
  },
  {
    name: "Content-Type only from bodyMimeType",
    bytes: Buffer.from("k=v"),
    mime: "application/x-www-form-urlencoded",
    noContentTypeHeader: true,
  },
  { name: "empty text body", bytes: Buffer.alloc(0), mime: "text/plain" },
  {
    name: "empty base64 body",
    bytes: Buffer.alloc(0),
    mime: "application/octet-stream",
    mode: "base64",
  },
  {
    name: "GET with JSON body",
    bytes: Buffer.from('{"q":"\u00e9","n":12345678901234567890}'),
    mime: "application/json",
    method: "GET",
  },
  {
    name: "DELETE with binary body",
    bytes: INVALID_UTF8,
    mime: "application/octet-stream",
    mode: "base64",
    method: "DELETE",
  },
  {
    name: "OPTIONS with urlencoded body",
    bytes: Buffer.from(URLENCODED_ODD),
    mime: "application/x-www-form-urlencoded",
    method: "OPTIONS",
  },
  { name: "JSON null scalar", bytes: Buffer.from("null"), mime: "application/json" },
  { name: "JSON true scalar", bytes: Buffer.from("true"), mime: "application/json" },
  {
    name: "JSON padded false scalar",
    bytes: Buffer.from("  false\n"),
    mime: "application/json",
    method: "PUT",
  },
  { name: "JSON zero and string scalars", bytes: Buffer.from("0"), mime: "application/json" },
  {
    name: "JSON null scalar (base64)",
    bytes: Buffer.from("null"),
    mime: "application/json",
    mode: "base64",
  },
  {
    name: "latin-1 charset in header only, base64 original",
    bytes: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xff, 0x00]),
    mime: "text/plain; charset=iso-8859-1",
    mode: "base64",
    headerOnlyMime: true,
  },
  {
    name: "UTF-8 charset in header only, text original",
    bytes: Buffer.from("caf\u00e9 \u65e5\u672c"),
    mime: "text/plain; charset=utf-8",
    headerOnlyMime: true,
  },
  {
    name: "genuine U+FFFD bytes from base64",
    bytes: Buffer.from("a\ufffdb", "utf8"),
    mime: "text/plain",
    mode: "base64",
  },
  {
    name: "explicit original bytes win over lossy raw text",
    bytes: Buffer.from([0x61, 0xff, 0xfe, 0x00, 0x80, 0x62]),
    mime: "application/octet-stream",
    explicitBytes: true,
    lossyText: "a\ufffd\ufffd\u0000\ufffdb",
  },
  ...JSON_TEXT_CASES,
].map((c, index) => ({ ...c, index, path: "/body/" + index }));

// -- Pure helpers --

function codeLines(code) {
  return code.split("\n");
}

// A Python literal that can't be split: one string or number, alone or as the value of a
// "key": pair, as a list or dict item.
const WHOLE_STRING_ITEM =
  /^\s*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'): )?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?),?$/;

// Widest line, ignoring the entries of a `headers=` block and lines that are one whole string
// item: header and item string values are never split, so a long User-Agent or URL value may
// exceed the width on purpose.
function maxWidth(code) {
  const lines = [];
  let headerIndent = null;
  for (const line of codeLines(code)) {
    const indent = line.length - line.trimStart().length;
    if (headerIndent !== null) {
      if (indent === headerIndent && /^[\]}]/.test(line.trimStart())) headerIndent = null;
      continue;
    }
    if (/^\s*headers=[[{]$/.test(line)) headerIndent = indent;
    if (!WHOLE_STRING_ITEM.test(line)) lines.push(line);
  }
  return Math.max(...lines.map((line) => [...line].length));
}

function importedModules(code) {
  const modules = new Set();
  for (const line of codeLines(code)) {
    const match = /^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/.exec(line);
    if (match) modules.add(match[1].split(".")[0]);
  }
  return modules;
}

// Query escapes use canonical uppercase hex for python-requests, which cannot send lowercase or
// escaped-unreserved targets verbatim. "mixed" keeps lowercase escapes and is only valid for httpx.
function longUrl(base, style = "canonical") {
  const lower = style === "mixed";
  const slash = lower ? "%2f" : "%2F";
  const eacute = lower ? "%e9" : "%E9";
  const query = Array.from(
    { length: 40 },
    (_, i) => `q${i % 5}=v${i % 2 ? "%2F" : slash}${i}&e${i}=&e${i}`
  ).join("&");
  return `${base}/long/a%2Fb?${query}&&z&x=1&x=&x=2&w=${eacute}&p=a+b`;
}

function widthEntries(base) {
  const urlencoded = Buffer.from(URLENCODED_LONG + "&" + URLENCODED_ODD);
  const binary = Buffer.alloc(1000);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 7) & 0xff;
  return [
    entry(
      {
        url: longUrl(base),
        method: "POST",
        headers: headerList([["Content-Type", "application/x-www-form-urlencoded"]]),
        bodySize: urlencoded.length,
        bodyMimeType: "application/x-www-form-urlencoded",
      },
      { _rawRequestBody: urlencoded.toString("utf8") }
    ),
    entry(
      {
        url: base + "/bin",
        method: "POST",
        headers: headerList([["Content-Type", "application/octet-stream"]]),
        bodySize: binary.length,
        bodyMimeType: "application/octet-stream",
        bodyEncoding: "base64",
      },
      { _rawRequestBody: binary.toString("base64") }
    ),
  ];
}

// -- Regression tests --

for (const lib of LIBS) {
  test(`${lib.name}: generated code has no import statements and no print`, () => {
    const code = serializeFor(lib, [
      bodyEntry(
        BODY_CASES.find((c) => c.mode === "base64" && c.bytes === INVALID_UTF8),
        "http://h.test"
      ),
      bodyEntry(BODY_CASES[0], "http://h.test"),
    ]);
    assert.deepEqual([...importedModules(code)], []);
    assert.ok(!/\bbase64\b/.test(code), "generated code must not mention base64");
    assert.ok(!/^\s*print\(/m.test(code), "generated code must not print");
    assert.ok(code.startsWith("response = "), "output starts with the request assignment");
  });

  test(`${lib.name}: default width is 120 for long URLs and bodies`, () => {
    const code = serializeFor(lib, widthEntries("http://127.0.0.1:1"));
    assert.ok(maxWidth(code) <= 120, "widest line is " + maxWidth(code));
  });

  test(`${lib.name}: lineWidth option bounds wrapping and changes the layout`, () => {
    const entries = widthEntries("http://127.0.0.1:1");
    const narrow = serializeFor(lib, entries, { lineWidth: 72 });
    const wide = serializeFor(lib, entries, { lineWidth: 160 });
    assert.ok(maxWidth(narrow) <= 72, "narrow max " + maxWidth(narrow));
    assert.ok(maxWidth(wide) <= 160, "wide max " + maxWidth(wide));
    assert.ok(codeLines(wide).length < codeLines(narrow).length, "wider output needs fewer lines");
    const standard = serializeFor(lib, entries, { lineWidth: 120 });
    assert.equal(serializeFor(lib, entries), standard);
  });

  test(`${lib.name}: lineWidth has a 40-column floor and no upper limit; invalid values fall back to 120`, () => {
    const bare = [
      entry({ url: longUrl("http://127.0.0.1:1") }),
      entry(
        { url: "http://127.0.0.1:1/bin", method: "POST", bodySize: 600, bodyEncoding: "base64" },
        { _rawRequestBody: Buffer.alloc(600, 0xab).toString("base64") }
      ),
    ];
    const withWidth = (lineWidth) => serializeFor(lib, bare, { lineWidth });
    for (const lineWidth of [0, 1, -50, 39]) {
      assert.ok(maxWidth(withWidth(lineWidth)) <= 40, "min clamp, width " + lineWidth);
    }
    // Wider than any previous cap: the long URL and body may use the whole width.
    const wide = withWidth(400);
    assert.ok(maxWidth(wide) <= 400, "wide max " + maxWidth(wide));
    const widest = Math.max(...codeLines(wide).map((line) => [...line].length));
    assert.ok(widest > 160, "widths above 160 are honoured, widest " + widest);
    assert.ok(codeLines(wide).length < codeLines(withWidth(160)).length, "400 needs fewer lines");
    const standard = serializeFor(lib, bare);
    for (const lineWidth of [NaN, Infinity, "wide", null, undefined, {}]) {
      assert.equal(withWidth(lineWidth), standard, "fallback for " + String(lineWidth));
    }
    assert.equal(withWidth("100"), withWidth(100), "numeric strings are accepted");
    assert.ok(maxWidth(withWidth(100)) <= 100);
    assert.equal(serializeFor(lib, bare, {}), standard);
  });

  test(`${lib.name}: lossy HAR text is rejected instead of re-encoded`, () => {
    const bad = (text) =>
      assert.throws(
        () =>
          serializeFor(lib, [
            entry(
              { method: "POST", bodySize: 4, bodyMimeType: "application/octet-stream" },
              { _rawRequestBody: text }
            ),
          ]),
        { name: "Error" }
      );
    bad("a\ufffdb"); // literal replacement character from a lossy decode
    bad("x\ud800y"); // lone surrogate cannot be UTF-8
    bad("\udc00");
  });

  test(`${lib.name}: unsupported captured encodings and uncaptured bodies are rejected`, () => {
    assert.throws(
      () =>
        serializeFor(lib, [
          entry({ method: "POST", bodySize: 3, bodyEncoding: "gzip" }, { _rawRequestBody: "abc" }),
        ]),
      /encoding/
    );
    assert.throws(
      () => serializeFor(lib, [entry({ method: "POST", bodySize: 12 })]),
      /not captured/
    );
  });
}

test("python-requests: duplicate header names are rejected, never merged silently", () => {
  for (const headers of [
    [
      ["X-Dup", "a"],
      ["X-Other", "b"],
      ["X-Dup", "c"],
    ],
    [
      ["X-Dup", "a"],
      ["x-dup", "c"],
    ],
  ]) {
    assert.throws(
      () => serializeFor(LIBS[0], [entry({ headers: headerList(headers) })]),
      /duplicate|multiple|same name|repeated/i
    );
  }
});

for (const lib of LIBS) {
  test(`${lib.name}: non-UTF-8 charset only in the Content-Type header rejects raw text`, () => {
    const headers = headerList([["Content-Type", "text/plain; charset=iso-8859-1"]]);
    assert.throws(
      () =>
        serializeFor(lib, [
          entry({ method: "POST", headers, bodySize: 4 }, { _rawRequestBody: "caf\u00e9" }),
        ]),
      { name: "Error" }
    );
  });

  test(`${lib.name}: raw ASCII multipart is emitted as bytes.fromhex with the exact boundary`, () => {
    const body = MULTIPART_TEXT;
    const code = serializeFor(lib, [
      entry(
        {
          url: "http://h.test/up",
          method: "POST",
          headers: headerList([["Content-Type", `multipart/form-data; boundary=${BOUNDARY}`]]),
          bodySize: body.length,
        },
        { _rawRequestBody: body.toString("utf8") }
      ),
    ]);
    assert.ok(/bytes\.fromhex\(/.test(code), "multipart body must be bytes.fromhex");
    assert.ok(code.includes(`boundary=${BOUNDARY}`), "boundary must be kept in Content-Type");
  });

  test(`${lib.name}: exact JSON text with a non-JSON type becomes a Python structure`, () => {
    const cases = BODY_CASES.filter((c) => "payload" in c);
    const render = (c, options) => serializeFor(lib, [bodyEntry(c, "http://h.test")], options);
    const keyword = lib.module === "httpx" ? "content=" : "data=";
    const walrus =
      'stringify := lambda v: json.dumps(v, separators=(",", ":"), ensure_ascii=False)';
    const def =
      'def stringify(value):\n    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)\n';
    for (const c of cases) {
      // `c.walrus` marks bodies whose outer value is compact JSON holding nested JSON text.
      const code = render(c);
      const walrusCode = render(c, { pythonNestedJson: "walrus" });
      const inline = render(c, { pythonNestedJson: "inline" });
      assert.equal(code.includes(keyword + "stringify({"), Boolean(c.walrus), c.name + code);
      assert.equal(code.startsWith(def), /\bstringify\(/.test(code.slice(def.length)), c.name);
      assert.ok(!code.includes(":="), c.name + ": the default must not use the walrus helper");
      assert.equal(code.includes(keyword + "json.dumps("), c.payload && !c.walrus, c.name);
      assert.equal(walrusCode.includes(walrus), Boolean(c.walrus), c.name + walrusCode);
      assert.ok(!walrusCode.includes("def stringify"), c.name);
      assert.equal(inline.includes(keyword + "json.dumps("), c.payload, c.name + inline);
      assert.ok(!/:=|\bstringify\(/.test(inline), c.name + ": inline mode uses no helper");
      for (const text of [code, walrusCode, inline]) {
        assert.ok(
          !/\bjson=/.test(text),
          c.name + ": the captured Content-Type must not become JSON"
        );
        assert.ok(!text.includes("payload"), c.name + ": Python inlines the structure");
        assert.ok(text.includes('"Content-Type": "text/plain;charset=UTF-8"'), c.name);
      }
      // The collector body nests six levels deep, too deep for 40 columns.
      for (const lineWidth of c === cases[0] ? [60, 72] : [40, 60]) {
        for (const pythonNestedJson of ["function", "walrus", "inline"]) {
          const narrow = render(c, { lineWidth, pythonNestedJson });
          assert.ok(maxWidth(narrow) <= lineWidth, c.name + " at " + lineWidth + "\n" + narrow);
        }
      }
    }
    // Layout assertions below are written for 88 columns, where the collector body must wrap.
    const collector = render(cases[0], { lineWidth: 88 });
    const encode = lib.module === "requests" ? '.encode("utf-8"),' : ",";
    assert.ok(collector.startsWith(def + "\n\nresponse = "), collector);
    assert.ok(collector.includes("\n    " + keyword + "stringify({\n"), collector);
    assert.ok(collector.includes("\n    })" + encode + "\n"), collector);
    assert.match(collector, /^ {16}"entries": stringify\(\[$/m);
    assert.match(collector, /^ {24}"name": "index-JVHuKBxQ\.css",$/m);
    assert.match(collector, /^ {16}\]\),$/m);
    assert.ok(collector.includes('"meta": stringify({"depth": 2, "ids": [1]})'), collector);
    assert.ok(collector.includes(`"spaced": '{"a": 1}',`), "spaced nested JSON stays text");
    assert.ok(
      collector.includes(`"escaped": '["caf\\\\u00e9"]',`),
      "escaped nested JSON stays text"
    );
    // Compare without layout: the flags list wraps at this indent (adding a trailing comma).
    const flat = collector.replace(/\s+/g, "").replace(/,([\]}])/g, "$1");
    for (const value of [
      '["false","5651832","null",stringify("q"),"[]x",stringify({})]',
      '"numbers":["[1e-7]",stringify([1.0]),stringify([12345678901234567890])]',
    ]) {
      assert.ok(flat.includes(value), value + "\n" + collector);
    }
    assert.match(collector, /^ {8}"request_context": \{"referrer": "", .*\},$/m);
    const walrusCollector = render(cases[0], { pythonNestedJson: "walrus", lineWidth: 88 });
    // At 88 columns the binding no longer fits after `content=(`, so it gets its own line.
    assert.ok(
      walrusCollector.includes("\n    " + keyword + "(\n        " + walrus + "\n    )({\n"),
      walrusCollector
    );
    assert.ok(
      walrusCollector.includes('"meta": stringify({"depth": 2, "ids": [1]})'),
      walrusCollector
    );
    const inline = render(cases[0], { pythonNestedJson: "inline", lineWidth: 88 });
    assert.ok(inline.includes('"meta": json.dumps('), inline);
    assert.ok(inline.includes('], separators=(",", ":"), ensure_ascii=False),'), inline);
    // An outer body in json.dumps's default spacing cannot be sent through a compact helper, but
    // its nested values can still use the declared one.
    const spaced = render(cases[1]);
    assert.ok(spaced.includes('"a": stringify([1, {"b": 2}])'), spaced);
    assert.ok(spaced.includes(keyword + "json.dumps({"), spaced);
    const spacedWalrus = render(cases[1], { pythonNestedJson: "walrus" });
    const nested = 'json.dumps([1, {"b": 2}], separators=(",", ":"), ensure_ascii=False)';
    assert.ok(spacedWalrus.includes('"a": ' + nested), "walrus needs a compact outer body");
    assert.ok(spaced.includes('"c": "[1, 2]"'), spaced);
    const ascii = render(cases[3]);
    assert.ok(ascii.includes(keyword + 'json.dumps({"q": "caf\u00e9", "n": [1, 2]}),'), ascii);
    const unicode = render(cases[2]);
    const call = '}, separators=(",", ":"), ensure_ascii=False)';
    assert.ok(unicode.includes(call + encode), unicode);
  });

  test(`${lib.name}: a batch declares the stringify helper once, before the first request`, () => {
    const collector = BODY_CASES.find((c) => c.walrus);
    const code = serializeFor(lib, [
      bodyEntry(collector, "http://h.test"),
      bodyEntry(collector, "http://h.test"),
    ]);
    assert.equal(code.split("def stringify(").length - 1, 1, code);
    assert.ok(code.startsWith("def stringify("), code);
    assert.equal(code.split("response = ").length - 1, 2, code);
  });

  test(`${lib.name}: exact JSON with a JSON type passes the structure as json=`, () => {
    const text =
      lib.module === "httpx" ? '{"a":[1,{"b":null}],"c":"\u00e9"}' : '{"a": [1, {"b": null}]}';
    const c = { bytes: Buffer.from(text), mime: "application/json", index: 0, path: "/" };
    const code = serializeFor(lib, [bodyEntry(c, "http://h.test")]);
    assert.ok(code.includes("    json={"), code);
  });
}

test("python-httpx: GET/DELETE/OPTIONS with a body use httpx.request(method=...), not helpers", () => {
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    const code = serializeFor(LIBS[1], [
      entry({ url: "http://h.test/x", method, bodySize: 3 }, { _rawRequestBody: "a=1" }),
    ]);
    assert.ok(/^response = httpx\.request\(/.test(code), method + " must use httpx.request");
    assert.ok(!/httpx\.(get|delete|options|head)\(/.test(code), method + " must not use a helper");
    assert.deepEqual([...importedModules(code)], []);
  }
});

test("normalize: empty text body is a present empty body, absent body is null", () => {
  const empty = RequestCode.normalize(
    entry({ method: "POST", bodySize: 0 }, { _rawRequestBody: "" })
  );
  assert.ok(empty.body);
  assert.equal(empty.body.bytes.length, 0);
  assert.equal(RequestCode.normalize(entry({ method: "POST", bodySize: 0 })).body, null);
});

test("normalize: UTF-8 body bytes and header order feed the generators unchanged", () => {
  const normalized = RequestCode.normalize(
    entry(
      {
        method: "POST",
        headers: headerList([
          ["B", "1"],
          ["a", "2"],
          ["B", "3"],
        ]),
        bodySize: Buffer.byteLength(UNICODE_TEXT),
      },
      { _rawRequestBody: UNICODE_TEXT }
    )
  );
  assert.deepEqual(
    normalized.headers.map((pair) => Array.from(pair)),
    [
      ["B", "1"],
      ["a", "2"],
      ["B", "3"],
    ]
  );
  assert.ok(Buffer.from(normalized.body.bytes).equals(Buffer.from(UNICODE_TEXT)));
});

// -- Native loopback tests --

function probeInterpreters() {
  const probe =
    "import json\nr={}\nfor m in ('requests','httpx'):\n try:\n  __import__(m); r[m]=True\n except Exception:\n  r[m]=False\nprint(json.dumps(r))";
  const candidates = [
    process.env.PYTHON_REQUEST_CODE_PYTHON,
    process.env.PYTHON,
    "python",
    "python3",
    "C:\\py\\pythoncore-3.14-64\\python.exe",
    "C:\\py\\bin\\python.exe",
  ].filter(Boolean);
  const found = { requests: null, httpx: null };
  for (const command of candidates) {
    const result = childProcess.spawnSync(command, ["-c", probe], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    let libs;
    try {
      libs = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
    } catch {
      continue;
    }
    for (const module of Object.keys(found))
      if (!found[module] && libs[module]) found[module] = command;
  }
  return found;
}

const interpreters = probeInterpreters();

function skipReason(lib) {
  return interpreters[lib.module] ? false : `no Python interpreter with ${lib.module} found`;
}

function headBlock(raw) {
  return raw.toString("latin1").split("\r\n");
}

function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) return null;
    const size = parseInt(buffer.subarray(offset, lineEnd).toString("latin1"), 16);
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(parts);
    if (buffer.length < offset + size + 2) return null;
    parts.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
}

// Raw socket HTTP/1.1 receiver: records request line, ordered headers and body bytes.
function startServer() {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let done = false;
    socket.on("data", (chunk) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const lines = headBlock(buffer.subarray(0, end));
      const headers = lines.slice(1).map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      });
      const find = (name) => headers.find(([n]) => n.toLowerCase() === name);
      const rest = buffer.subarray(end + 4);
      let body;
      const chunked = /chunked/i.test(find("transfer-encoding")?.[1] || "");
      if (chunked) {
        body = decodeChunked(rest);
        if (!body) return;
      } else {
        const length = Number(find("content-length")?.[1] || 0);
        if (rest.length < length) return;
        body = Buffer.from(rest.subarray(0, length));
      }
      done = true;
      const [method, target] = lines[0].split(" ");
      requests.push({ method, target, headers, body, chunked });
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      })
    );
  });
}

const WRAPPER = [
  "import ast, json, sys",
  "path = sys.argv[1]",
  "with open(path, encoding='utf-8') as handle:",
  "    source = handle.read()",
  "tree = ast.parse(source, path)",
  "mods = set()",
  "for node in ast.walk(tree):",
  "    if isinstance(node, ast.Import):",
  "        mods.update(alias.name.split('.')[0] for alias in node.names)",
  "    elif isinstance(node, ast.ImportFrom) and node.module:",
  "        mods.add(node.module.split('.')[0])",
  "prints = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, 'id', None) == 'print']",
  "sys.stdout.write('IMPORTS ' + json.dumps(sorted(mods)) + '\\n')",
  "sys.stdout.write('PRINTS ' + json.dumps(prints) + '\\n')",
  "sys.stdout.flush()",
  "# The generated code intentionally has no imports; provide json and the library under test.",
  "import importlib",
  "exec(compile(tree, path, 'exec'), {'__name__': '__main__', 'json': json, sys.argv[2]: importlib.import_module(sys.argv[2])})",
  "",
].join("\n");

function spawnPython(python, args, env) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(python, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: stderr + String(error), timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(https?_proxy|all_proxy|no_proxy|requests_ca_bundle|curl_ca_bundle|ssl_cert_file)$/i.test(
        key
      )
    )
      delete env[key];
  }
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

// Starts the loopback server, evaluates `makeCode(base)` and runs it. Always cleans up.
async function execute(lib, makeCode) {
  const server = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-code-py-"));
  try {
    const code = makeCode(`http://127.0.0.1:${server.port}`);
    const wrapper = path.join(dir, "wrapper.py");
    const script = path.join(dir, "generated.py");
    fs.writeFileSync(wrapper, WRAPPER, "utf8");
    fs.writeFileSync(script, code, "utf8");
    const result = await spawnPython(
      interpreters[lib.module],
      ["-X", "utf8", wrapper, script, lib.module],
      cleanEnv()
    );
    const imports = /^IMPORTS (.*)$/m.exec(result.stdout);
    const prints = /^PRINTS (.*)$/m.exec(result.stdout);
    return {
      code,
      ...result,
      imports: imports ? JSON.parse(imports[1]) : null,
      prints: prints ? JSON.parse(prints[1]) : null,
      requests: server.requests,
    };
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertRan(result, expectedRequests) {
  const detail = `\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`;
  assert.ok(!result.timedOut, "python timed out" + detail);
  assert.equal(result.status, 0, "python failed" + detail);
  assert.equal(result.requests.length, expectedRequests, "request count" + detail);
}

function headerValues(request, name) {
  return request.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
}

for (const lib of LIBS) {
  test(
    `${lib.name}: native bodies, headers and framing arrive byte-for-byte`,
    { skip: skipReason(lib), timeout: 120000 },
    async () => {
      const result = await execute(lib, (base) =>
        serializeFor(
          lib,
          BODY_CASES.map((c) => bodyEntry(c, base))
        )
      );
      assertRan(result, BODY_CASES.length);
      assert.deepEqual(result.imports, [], "generated code must not contain import statements");
      assert.deepEqual(result.prints, [], "generated code must not print");

      const failures = [];
      for (const c of BODY_CASES) {
        try {
          const request = result.requests[c.index];
          assert.ok(request, "request missing");
          assert.equal(request.method, c.method || "POST");
          assert.equal(request.target, c.path);
          assert.equal(request.chunked, false, "body must not be chunked");
          assert.equal(request.body.toString("hex"), c.bytes.toString("hex"));
          const lengths = headerValues(request, "content-length");
          if (c.bytes.length) assert.deepEqual(lengths, [String(c.bytes.length)]);
          else assert.ok(lengths.length === 0 || (lengths.length === 1 && lengths[0] === "0"));
          assert.deepEqual(headerValues(request, "transfer-encoding"), []);
          assert.ok(!request.headers.some(([n]) => n.startsWith(":")), "pseudo header leaked");
          assert.deepEqual(headerValues(request, "x-case"), [String(c.index)]);
          if (c.mime) assert.deepEqual(headerValues(request, "content-type"), [c.mime]);
          if (c.headers?.[0]) {
            assert.deepEqual(headerValues(request, c.headers[0][0].toLowerCase()), [
              c.headers[0][1],
            ]);
          }
        } catch (error) {
          failures.push(`[${c.name}] ${String(error.message).slice(0, 400)}`);
        }
      }
      assert.deepEqual(failures, []);
    }
  );

  // The default stringify helper is covered by the byte-for-byte test above.
  for (const [mode, forbidden] of [
    ["inline", /:=|stringify/],
    ["walrus", /def stringify/],
  ]) {
    test(
      `${lib.name}: native JSON text bodies are byte-exact with ${mode} nested JSON and narrow lines`,
      { skip: skipReason(lib), timeout: 60000 },
      async () => {
        const cases = BODY_CASES.filter((c) => c.text !== undefined);
        const result = await execute(lib, (base) =>
          serializeFor(
            lib,
            cases.map((c) => bodyEntry(c, base)),
            { pythonNestedJson: mode, lineWidth: 60 }
          )
        );
        assertRan(result, cases.length);
        assert.ok(!forbidden.test(result.code), mode + " mode must not use another helper");
        cases.forEach((c, index) => {
          const request = result.requests[index];
          assert.equal(request.target, c.path, c.name);
          assert.equal(request.body.toString("hex"), c.bytes.toString("hex"), c.name);
          assert.deepEqual(headerValues(request, "content-type"), [c.mime], c.name);
        });
      }
    );
  }

  test(
    `${lib.name}: native long URL with encoded duplicate and empty params is preserved`,
    { skip: skipReason(lib), timeout: 60000 },
    async () => {
      const styles = lib.module === "httpx" ? ["canonical", "mixed"] : ["canonical"];
      let targets;
      const result = await execute(lib, (base) => {
        const urls = styles.map((style) => longUrl(base, style));
        targets = urls.map((url) => url.slice(base.length));
        return serializeFor(
          lib,
          urls.map((url) => entry({ url }))
        );
      });
      assertRan(result, styles.length);
      styles.forEach((style, i) => {
        const request = result.requests[i];
        assert.equal(request.method, "GET", style);
        assert.equal(request.target, targets[i], style);
        assert.equal(request.body.length, 0, style);
        assert.deepEqual(headerValues(request, "transfer-encoding"), [], style);
        const lengths = headerValues(request, "content-length");
        assert.ok(lengths.length === 0 || (lengths.length === 1 && lengths[0] === "0"), style);
      });
    }
  );

  test(
    `${lib.name}: native absent body on GET/DELETE and empty vs absent body on POST`,
    { skip: skipReason(lib), timeout: 60000 },
    async () => {
      const result = await execute(lib, (base) =>
        serializeFor(lib, [
          entry({ url: base + "/get-absent" }),
          entry({ url: base + "/delete-absent", method: "DELETE" }),
          entry({ url: base + "/post-absent", method: "POST", bodySize: 0 }),
          entry(
            { url: base + "/post-empty", method: "POST", bodySize: 0 },
            { _rawRequestBody: "" }
          ),
        ])
      );
      assertRan(result, 4);
      const [get, del, absent, empty] = result.requests;
      for (const request of [get, del]) {
        assert.equal(request.body.length, 0);
        assert.deepEqual(headerValues(request, "transfer-encoding"), []);
        const lengths = headerValues(request, "content-length");
        assert.ok(lengths.length === 0 || (lengths.length === 1 && lengths[0] === "0"));
      }
      for (const request of [absent, empty]) {
        assert.equal(request.body.length, 0);
        assert.deepEqual(headerValues(request, "transfer-encoding"), []);
        const lengths = headerValues(request, "content-length");
        assert.ok(lengths.length === 0 || (lengths.length === 1 && lengths[0] === "0"));
      }
    }
  );

  test(
    `${lib.name}: native structured-only params use the exact serialization normalize reports`,
    { skip: skipReason(lib), timeout: 60000 },
    async () => {
      const params = [
        { name: "a", value: "1" },
        { name: "a", value: "2" },
        { name: "b", value: "x y" },
        { name: "\u00e9", value: "\u65e5\u672c" },
        { name: "e", value: "" },
      ];
      const make = (base) =>
        entry(
          { url: base + "/params", method: "POST", bodySize: 0 },
          { _requestPostData: { mimeType: "application/x-www-form-urlencoded", params } }
        );
      let expected;
      const result = await execute(lib, (base) => {
        expected = Buffer.from(RequestCode.normalize(make(base)).body.bytes);
        return serializeFor(lib, [make(base)]);
      });
      assertRan(result, 1);
      assert.equal(result.requests[0].body.toString("hex"), expected.toString("hex"));
      assert.equal(expected.toString("utf8"), "a=1&a=2&b=x+y&%C3%A9=%E6%97%A5%E6%9C%AC&e=");
      assert.deepEqual(headerValues(result.requests[0], "content-type"), [
        "application/x-www-form-urlencoded",
      ]);
    }
  );

  test(
    `${lib.name}: native output is valid and byte-exact at every line width`,
    { skip: skipReason(lib), timeout: 120000 },
    async () => {
      const widths = [undefined, 72, 120, 0, 1, 1e9, NaN];
      let sources;
      const result = await execute(lib, (base) => {
        sources = widthEntries(base);
        return widths.map((lineWidth) => serializeFor(lib, sources, { lineWidth })).join("\n");
      });
      assertRan(result, widths.length * 2);
      const expectedUrl = (entries) =>
        entries[0]._record.request.url.replace(/^http:\/\/[^/]+/, "");
      const urlBody = Buffer.from(sources[0]._rawRequestBody, "utf8");
      const binBody = Buffer.from(sources[1]._rawRequestBody, "base64");
      widths.forEach((width, i) => {
        const [form, bin] = result.requests.slice(i * 2, i * 2 + 2);
        const label = "lineWidth=" + width;
        assert.equal(form.target, expectedUrl(sources), label);
        assert.equal(form.body.toString("hex"), urlBody.toString("hex"), label);
        assert.equal(bin.body.toString("hex"), binBody.toString("hex"), label);
      });
    }
  );
}

test(
  "python-httpx: native duplicate headers are preserved in captured order",
  { skip: skipReason(LIBS[1]), timeout: 60000 },
  async () => {
    const captured = [
      ["X-Dup", "first"],
      ["Content-Type", "text/plain"],
      ["X-Other", "middle"],
      ["x-dup", "second"],
      ["Content-Length", "1"],
      ["X-Dup", "third, with comma"],
    ];
    const result = await execute(LIBS[1], (base) =>
      serializeFor(LIBS[1], [
        entry(
          { url: base + "/dups", method: "POST", headers: headerList(captured), bodySize: 2 },
          { _rawRequestBody: "hi" }
        ),
      ])
    );
    assertRan(result, 1);
    const seen = result.requests[0].headers
      .filter(([name]) => /^(x-dup|x-other|content-type)$/i.test(name))
      .map(([name, value]) => [name.toLowerCase(), value]);
    assert.deepEqual(seen, [
      ["x-dup", "first"],
      ["content-type", "text/plain"],
      ["x-other", "middle"],
      ["x-dup", "second"],
      ["x-dup", "third, with comma"],
    ]);
    assert.deepEqual(headerValues(result.requests[0], "content-length"), ["2"]);
  }
);

test(
  "python-requests: native unique captured headers keep their values and relative order",
  { skip: skipReason(LIBS[0]), timeout: 60000 },
  async () => {
    const captured = [
      ["X-First", "1"],
      ["X-Second", "two words"],
      ["User-Agent", "captured-agent/1.0"],
      ["X-Third", "3"],
      ["Accept", "text/x-custom"],
    ];
    const result = await execute(LIBS[0], (base) =>
      serializeFor(LIBS[0], [entry({ url: base + "/hdr", headers: headerList(captured) })])
    );
    assertRan(result, 1);
    const seen = result.requests[0].headers;
    const custom = seen.filter(([name]) => /^x-/i.test(name)).map(([name, value]) => [name, value]);
    assert.deepEqual(custom, [
      ["X-First", "1"],
      ["X-Second", "two words"],
      ["X-Third", "3"],
    ]);
    assert.deepEqual(headerValues(result.requests[0], "user-agent"), ["captured-agent/1.0"]);
    assert.deepEqual(headerValues(result.requests[0], "accept"), ["text/x-custom"]);
  }
);

test("python-requests: URLs that requests would rewrite are rejected with a diagnostic", () => {
  const base = "http://127.0.0.1:1";
  const unsupported = [
    longUrl(base, "mixed"),
    base + "/a%2fb",
    base + "/p?w=%e9",
    base + "/t%7E",
    base + "/p?x=%7E",
    base + "/p?x=%41",
    base + "/p?x=%zz",
  ];
  for (const url of unsupported) {
    assert.throws(
      () => serializeFor(LIBS[0], [entry({ url })]),
      { name: "Error", message: /Requests normalizes this URL/ },
      url
    );
  }
});

test(
  "python-httpx: native lowercase and escaped-unreserved URL targets are preserved exactly",
  { skip: skipReason(LIBS[1]), timeout: 60000 },
  async () => {
    const targets = ["/t%7E/%7e?x=%7E&y=%7e&z&&z=", "/low%2fer?w=%e9&w=%E9&w=&p=a+b"];
    const result = await execute(LIBS[1], (base) =>
      serializeFor(
        LIBS[1],
        targets.map((target) => entry({ url: base + target }))
      )
    );
    assertRan(result, targets.length);
    assert.deepEqual(
      result.requests.map((request) => request.target),
      targets
    );
  }
);
