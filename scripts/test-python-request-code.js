// Tests Python replay syntax, formatting, and wire bytes with real requests/httpx clients.
// Run with `bun test scripts/test-python-request-code.js`. Native cases skip if unavailable;
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

const LIBS = [
  { format: "python-requests", module: "requests" },
  { format: "python-httpx", module: "httpx" },
];

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
].map((c, index) => ({ ...c, index, path: "/body/" + index }));

// -- Pure helpers --

function codeLines(code) {
  return code.split("\n");
}

function maxWidth(code) {
  return Math.max(...codeLines(code).map((line) => [...line].length));
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
  test(`${lib.format}: generated code has no import statements and no print`, () => {
    const code = RequestCode.serialize(lib.format, [
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

  test(`${lib.format}: default width is 88 for long URLs and bodies`, () => {
    const code = RequestCode.serialize(lib.format, widthEntries("http://127.0.0.1:1"));
    assert.ok(maxWidth(code) <= 88, "widest line is " + maxWidth(code));
  });

  test(`${lib.format}: lineWidth option bounds wrapping and changes the layout`, () => {
    const entries = widthEntries("http://127.0.0.1:1");
    const narrow = RequestCode.serialize(lib.format, entries, { lineWidth: 72 });
    const wide = RequestCode.serialize(lib.format, entries, { lineWidth: 120 });
    assert.ok(maxWidth(narrow) <= 72, "narrow max " + maxWidth(narrow));
    assert.ok(maxWidth(wide) <= 120, "wide max " + maxWidth(wide));
    assert.ok(codeLines(wide).length < codeLines(narrow).length, "wider output needs fewer lines");
    const standard = RequestCode.serialize(lib.format, entries, { lineWidth: 88 });
    assert.equal(RequestCode.serialize(lib.format, entries), standard);
  });

  test(`${lib.format}: lineWidth is clamped to 40..160, invalid values fall back to 88`, () => {
    const bare = [
      entry({ url: longUrl("http://127.0.0.1:1") }),
      entry(
        { url: "http://127.0.0.1:1/bin", method: "POST", bodySize: 600, bodyEncoding: "base64" },
        { _rawRequestBody: Buffer.alloc(600, 0xab).toString("base64") }
      ),
    ];
    const withWidth = (lineWidth) => RequestCode.serialize(lib.format, bare, { lineWidth });
    for (const lineWidth of [0, 1, -50, 39]) {
      assert.ok(maxWidth(withWidth(lineWidth)) <= 40, "min clamp, width " + lineWidth);
    }
    for (const lineWidth of [161, 1e9]) {
      const code = withWidth(lineWidth);
      assert.ok(maxWidth(code) <= 160, "max clamp, width " + lineWidth);
    }
    const standard = RequestCode.serialize(lib.format, bare);
    for (const lineWidth of [NaN, Infinity, "wide", null, undefined, {}]) {
      assert.equal(withWidth(lineWidth), standard, "fallback for " + String(lineWidth));
    }
    assert.equal(withWidth("100"), withWidth(100), "numeric strings are accepted");
    assert.ok(maxWidth(withWidth(100)) <= 100);
    assert.equal(RequestCode.serialize(lib.format, bare, {}), standard);
  });

  test(`${lib.format}: lossy HAR text is rejected instead of re-encoded`, () => {
    const bad = (text) =>
      assert.throws(
        () =>
          RequestCode.serialize(lib.format, [
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

  test(`${lib.format}: unsupported captured encodings and uncaptured bodies are rejected`, () => {
    assert.throws(
      () =>
        RequestCode.serialize(lib.format, [
          entry({ method: "POST", bodySize: 3, bodyEncoding: "gzip" }, { _rawRequestBody: "abc" }),
        ]),
      /encoding/
    );
    assert.throws(
      () => RequestCode.serialize(lib.format, [entry({ method: "POST", bodySize: 12 })]),
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
      () => RequestCode.serialize("python-requests", [entry({ headers: headerList(headers) })]),
      /duplicate|multiple|same name|repeated/i
    );
  }
});

for (const lib of LIBS) {
  test(`${lib.format}: non-UTF-8 charset only in the Content-Type header rejects raw text`, () => {
    const headers = headerList([["Content-Type", "text/plain; charset=iso-8859-1"]]);
    assert.throws(
      () =>
        RequestCode.serialize(lib.format, [
          entry({ method: "POST", headers, bodySize: 4 }, { _rawRequestBody: "caf\u00e9" }),
        ]),
      { name: "Error" }
    );
  });

  test(`${lib.format}: raw ASCII multipart is emitted as bytes.fromhex with the exact boundary`, () => {
    const body = MULTIPART_TEXT;
    const code = RequestCode.serialize(lib.format, [
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
}

test("python-httpx: GET/DELETE/OPTIONS with a body use httpx.request(method=...), not helpers", () => {
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    const code = RequestCode.serialize("python-httpx", [
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
  "# The generated code intentionally has no imports; provide the library under test.",
  "import importlib",
  "exec(compile(tree, path, 'exec'), {'__name__': '__main__', sys.argv[2]: importlib.import_module(sys.argv[2])})",
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
    `${lib.format}: native bodies, headers and framing arrive byte-for-byte`,
    { skip: skipReason(lib), timeout: 120000 },
    async () => {
      const result = await execute(lib, (base) =>
        RequestCode.serialize(
          lib.format,
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

  test(
    `${lib.format}: native long URL with encoded duplicate and empty params is preserved`,
    { skip: skipReason(lib), timeout: 60000 },
    async () => {
      const styles = lib.module === "httpx" ? ["canonical", "mixed"] : ["canonical"];
      let targets;
      const result = await execute(lib, (base) => {
        const urls = styles.map((style) => longUrl(base, style));
        targets = urls.map((url) => url.slice(base.length));
        return RequestCode.serialize(
          lib.format,
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
    `${lib.format}: native absent body on GET/DELETE and empty vs absent body on POST`,
    { skip: skipReason(lib), timeout: 60000 },
    async () => {
      const result = await execute(lib, (base) =>
        RequestCode.serialize(lib.format, [
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
    `${lib.format}: native structured-only params use the exact serialization normalize reports`,
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
        return RequestCode.serialize(lib.format, [make(base)]);
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
    `${lib.format}: native output is valid and byte-exact at every line width`,
    { skip: skipReason(lib), timeout: 120000 },
    async () => {
      const widths = [undefined, 72, 120, 0, 1, 1e9, NaN];
      let sources;
      const result = await execute(lib, (base) => {
        sources = widthEntries(base);
        return widths
          .map((lineWidth) => RequestCode.serialize(lib.format, sources, { lineWidth }))
          .join("\n");
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
      RequestCode.serialize("python-httpx", [
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
      RequestCode.serialize("python-requests", [
        entry({ url: base + "/hdr", headers: headerList(captured) }),
      ])
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
      () => RequestCode.serialize("python-requests", [entry({ url })]),
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
      RequestCode.serialize(
        "python-httpx",
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
