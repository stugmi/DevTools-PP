// Behavioral tests for RequestCode JS generators (src/panel/js/lib/request-code.js).
// Run with `bun test scripts/test-request-code.js`. JS output is evaluated in a vm;
// a Windows-only loopback test also exercises native cURL request bytes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "lib", "request-code.js"),
  "utf8"
);
const libContext = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, URLSearchParams });
const RequestCode = vm.runInContext(`${source}\nRequestCode`, libContext);

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

function bytesOf(body) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("unexpected body type " + typeof body);
}

// Evaluates generated code and returns the ordered fetch calls.
async function run(format, entries, options) {
  const code = RequestCode.serialize(format, entries, options);
  const calls = [];
  const context = vm.createContext({
    Buffer,
    atob,
    btoa,
    Uint8Array,
    fetch: async (url, init) => {
      const call = {
        url,
        method: init.method,
        rawHeaders: Array.isArray(init.headers)
          ? Array.from(init.headers, ([name, value]) => [name, value])
          : Object.entries(init.headers || {}),
        headers: [...new Headers(init.headers)],
        credentials: init.credentials,
        hasBody: Object.hasOwn(init, "body"),
        body: bytesOf(init.body),
      };
      calls.push(call);
      return { text: async () => "response-" + calls.length };
    },
  });
  await vm.runInContext(`(async () => {\n${code}\n})()`, context);
  return { code, calls };
}

const FORMATS = ["fetch", "node-fetch"];

for (const format of FORMATS) {
  test(`${format}: tricky text survives evaluation in URL, headers and body`, async () => {
    const tricky =
      "\ufeff" +
      [
        `quote " apostrophe ' backslash \\ \\n literal`,
        "100% $HOME `cmd` $(cmd) !history ${js} #hash ;&|<>*?",
        "line1\nline2\r\nline3\ttab",
        "bmp \u00e9\u4e2d\u2028\u2029 astral \u{1F600}\u{10FFFF}",
        "nul\u0000mid \u007f del",
      ].join(" | ");
    const url = `https://example.test/p%20a?q=${encodeURIComponent(tricky)}&r=\\'"$!%25#frag`;
    const { calls } = await run(format, [
      entry(
        {
          url,
          method: "POST",
          headers: [{ name: "X-Note", value: tricky.replace(/[^\x20-\x7e]/g, "") }],
          bodySize: 1,
          bodyMimeType: "text/plain; charset=utf-8",
        },
        { _rawRequestBody: tricky }
      ),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(
      calls[0].rawHeaders.find(([n]) => n === "X-Note"),
      ["X-Note", tricky.replace(/[^\x20-\x7e]/g, "")]
    );
    assert.deepEqual(calls[0].body, Buffer.from(tricky, "utf8"));
  });

  test(`${format}: arbitrary binary bytes (NUL, 0xFF, all values) survive base64 body`, async () => {
    const all = Buffer.alloc(256 * 300 + 3);
    for (let i = 0; i < all.length; i++) all[i] = i & 0xff;
    all[0] = 0x00;
    all[1] = 0xff;
    const { calls } = await run(format, [
      entry(
        {
          method: "PUT",
          bodySize: all.length,
          bodyMimeType: "application/octet-stream",
          bodyEncoding: "base64",
        },
        { _rawRequestBody: all.toString("base64") }
      ),
    ]);
    assert.ok(calls[0].body.equals(all));
    assert.deepEqual(
      calls[0].headers.find(([n]) => n === "content-type"),
      ["content-type", "application/octet-stream"]
    );
  });

  test(`${format}: exact JSON text becomes a payload literal sent with JSON.stringify`, async () => {
    const collector = JSON.stringify({
      client_id: "1234567890.1730000000",
      events: [
        {
          context: JSON.stringify({ react: true, latency: 51.1, meta: JSON.stringify([1]) }),
          quote: 'it\'s "q" \\ \n\t \u00e9 \u{1F600}',
          "odd key": [true, false, null, -2.5, 0, {}, []],
          spaced: '{"a": 1}',
          scalars: ["false", "5651832", "null", '"q"', "{}"],
          // JavaScript prints these numbers differently, so they stay literal strings.
          numbers: ["[1e-7]", "[1.0]", "[12345678901234567890]", '{"__proto__":1}'],
        },
      ],
    });
    const cases = [
      { text: collector, payload: true },
      { text: '[{"a":1},"b"]', payload: true },
      { text: '{"a": 1}', payload: false },
      { text: '{"q":"\\u00e9"}', payload: false },
      { text: '{"a":1,"a":2}', payload: false },
      { text: '{"n":12345678901234567890}', payload: false },
      { text: '{"n":1.10}', payload: false },
      { text: '{"__proto__":{"x":1}}', payload: false },
      { text: '{"b":1,"1":2}', payload: false },
    ];
    for (const lineWidth of [40, 88]) {
      const { code, calls } = await run(
        format,
        cases.map(({ text }) =>
          entry(
            {
              method: "POST",
              headers: [{ name: "Content-Type", value: "text/plain;charset=UTF-8" }],
              bodySize: Buffer.byteLength(text),
            },
            { _rawRequestBody: text }
          )
        ),
        { lineWidth }
      );
      cases.forEach((c, index) => {
        assert.deepEqual(calls[index].body, Buffer.from(c.text, "utf8"), c.text);
        assert.deepEqual(calls[index].rawHeaders, [["Content-Type", "text/plain;charset=UTF-8"]]);
        const name = "payload" + (index + 1);
        assert.equal(code.includes("const " + name + " = "), c.payload, c.text);
        assert.equal(code.includes("body: JSON.stringify(" + name + "),"), c.payload, c.text);
      });
      if (lineWidth === 88) {
        assert.ok(code.includes("  meta: JSON.stringify([1]),\n      }),\n"), code);
        assert.ok(code.includes('"odd key": [true, false, null, -2.5, 0, {}, []],'), code);
        assert.ok(code.includes(`spaced: '{"a": 1}',`), code);
        assert.ok(
          code.includes(
            `scalars: ["false", "5651832", "null", JSON.stringify("q"), JSON.stringify({})],`
          ),
          code
        );
        assert.ok(
          code.includes(`["[1e-7]", "[1.0]", "[12345678901234567890]", '{"__proto__":1}'],`),
          code
        );
      }
    }
  });

  test(`${format}: postData.encoding base64 is honored without request.bodyEncoding`, async () => {
    const bytes = Buffer.from([0, 255, 254, 128, 10, 13]);
    const { calls } = await run(format, [
      entry(
        { method: "POST", bodySize: bytes.length },
        {
          _rawRequestBody: bytes.toString("base64"),
          _requestPostData: {
            mimeType: "application/octet-stream",
            encoding: "base64",
            params: [],
          },
        }
      ),
    ]);
    assert.ok(calls[0].body.equals(bytes));
  });

  test(`${format}: multiple requests run in order without redeclaration collisions`, async () => {
    const { calls } = await run(format, [
      entry({ url: "https://a.test/1", method: "GET" }),
      entry({ url: "https://b.test/2", method: "POST", bodySize: 1 }, { _rawRequestBody: "x" }),
      entry({ url: "https://c.test/3", method: "DELETE" }),
    ]);
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://a.test/1", "https://b.test/2", "https://c.test/3"]
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "POST", "DELETE"]
    );
  });

  test(`${format}: body-less requests send no body, empty text body stays an empty body`, async () => {
    const { calls } = await run(format, [
      entry({ method: "GET" }),
      entry({ method: "HEAD" }),
      entry({ method: "POST" }),
      entry({ method: "POST" }, { _rawRequestBody: "" }),
      entry({ method: "GET" }, { _rawRequestBody: "" }),
    ]);
    assert.equal(calls[0].hasBody, false);
    assert.equal(calls[1].hasBody, false);
    assert.equal(calls[2].hasBody, false);
    assert.equal(calls[3].hasBody, true);
    assert.equal(calls[3].body.length, 0);
    assert.equal(calls[4].hasBody, false);
  });

  test(`${format}: GET or HEAD with a non-empty body is rejected`, () => {
    for (const method of ["GET", "HEAD", "get"]) {
      assert.throws(
        () =>
          RequestCode.serialize(format, [entry({ method, bodySize: 1 }, { _rawRequestBody: "x" })]),
        /cannot replay/
      );
    }
  });

  test(`${format}: HTTP/2 pseudo and generated length headers are omitted, casing and order kept`, async () => {
    const { calls } = await run(format, [
      entry({
        method: "POST",
        headers: [
          { name: ":authority", value: "example.test" },
          { name: ":method", value: "POST" },
          { name: "Content-Length", value: "999" },
          { name: "TRANSFER-ENCODING", value: "chunked" },
          { name: "X-Custom-ID", value: "1" },
          { name: "accept", value: "a" },
          { name: "Accept", value: "b" },
        ],
      }),
    ]);
    assert.deepEqual(calls[0].rawHeaders, [
      ["X-Custom-ID", "1"],
      ["accept", "a"],
      ["Accept", "b"],
    ]);
    assert.deepEqual(calls[0].headers, [
      ["accept", "a, b"],
      ["x-custom-id", "1"],
    ]);
  });

  test(`${format}: Content-Type derived from body MIME only when absent`, async () => {
    const withHeader = await run(format, [
      entry(
        {
          method: "POST",
          headers: [{ name: "content-type", value: "text/x-own" }],
          bodyMimeType: "text/plain",
        },
        { _rawRequestBody: "a" }
      ),
    ]);
    assert.deepEqual(
      withHeader.calls[0].headers.filter(([n]) => n === "content-type"),
      [["content-type", "text/x-own"]]
    );
    const derived = await run(format, [
      entry({ method: "POST", bodyMimeType: "text/plain" }, { _rawRequestBody: "a" }),
    ]);
    assert.deepEqual(
      derived.calls[0].headers.filter(([n]) => n === "content-type"),
      [["content-type", "text/plain"]]
    );
    const bodyless = await run(format, [entry({ method: "GET", bodyMimeType: "text/plain" })]);
    assert.equal(
      bodyless.calls[0].headers.some(([n]) => n === "content-type"),
      false
    );
  });

  test(`${format}: duplicate url-encoded form params keep order and encoding`, async () => {
    const params = [
      { name: "a", value: "1" },
      { name: "b", value: "x y" },
      { name: "a", value: "&=" },
      { name: "u", value: "\u00e9\u{1F600}" },
      { name: "empty", value: "" },
    ];
    const { calls } = await run(format, [
      entry(
        {
          method: "POST",
          bodySize: 20,
          bodyMimeType: "application/x-www-form-urlencoded; charset=UTF-8",
        },
        { _requestPostData: { mimeType: "application/x-www-form-urlencoded", params } }
      ),
    ]);
    const text = calls[0].body.toString("utf8");
    assert.equal(text, "a=1&b=x+y&a=%26%3D&u=%C3%A9%F0%9F%98%80&empty=");
    assert.deepEqual(
      [...new URLSearchParams(text)],
      params.map((p) => [p.name, p.value])
    );
  });

  test(`${format}: raw body wins over parsed params`, async () => {
    const { calls } = await run(format, [
      entry(
        { method: "POST", bodySize: 7, bodyMimeType: "application/x-www-form-urlencoded" },
        {
          _rawRequestBody: "a=1&a=2",
          _requestPostData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [{ name: "a", value: "9" }],
          },
        }
      ),
    ]);
    assert.equal(calls[0].body.toString("utf8"), "a=1&a=2");
  });

  test(`${format}: missing or invalid captured bodies fail instead of serializing metadata`, () => {
    const bad = (request, extra, pattern) =>
      assert.throws(
        () => RequestCode.serialize(format, [entry({ method: "POST", ...request }, extra)]),
        pattern
      );
    // Size says a body existed but no bytes were captured.
    bad({ bodySize: 12 }, {}, /not captured/);
    // Explicit body field on the record is not a substitute for captured bytes.
    bad({ body: { text: "meta" } }, {}, /not captured/);
    // Invalid base64.
    bad({ bodySize: 3, bodyEncoding: "base64" }, { _rawRequestBody: "***not base64***" }, /base64/);
    // Unsupported encodings.
    bad({ bodySize: 3, bodyEncoding: "gzip" }, { _rawRequestBody: "abc" }, /encoding/);
    bad(
      { bodySize: 3 },
      { _rawRequestBody: "abc", _requestPostData: { encoding: "hex", params: [] } },
      /encoding/
    );
    // Non-UTF-8 charset text cannot be reproduced byte-for-byte.
    bad(
      { bodySize: 3, bodyMimeType: "text/plain; charset=shift_jis" },
      { _rawRequestBody: "abc" },
      /byte-for-byte/
    );
    // Multipart / file uploads.
    bad(
      { bodySize: 30, bodyMimeType: "multipart/form-data; boundary=x" },
      {
        _requestPostData: {
          mimeType: "multipart/form-data; boundary=x",
          params: [{ name: "f", value: "v" }],
        },
      },
      /multipart|not captured/
    );
    bad(
      { bodySize: 30, bodyMimeType: "application/x-www-form-urlencoded" },
      {
        _requestPostData: {
          mimeType: "application/x-www-form-urlencoded",
          params: [{ name: "f", fileName: "a.txt", value: "v" }],
        },
      },
      /uploaded file/
    );
    bad(
      { bodySize: 30, bodyMimeType: "application/x-www-form-urlencoded" },
      {
        _requestPostData: {
          mimeType: "application/x-www-form-urlencoded",
          params: [{ name: "f", value: null }],
        },
      },
      /uploaded file/
    );
  });

  test(`${format}: special JavaScript property names retain header values and order`, async () => {
    const headers = [
      { name: "__proto__", value: "literal-header" },
      { name: "10", value: "ten" },
      { name: "2", value: "two" },
    ];
    const { calls } = await run(format, [entry({ headers })]);
    assert.deepEqual(
      calls[0].rawHeaders,
      headers.map(({ name, value }) => [name, value])
    );
  });

  test(`${format}: wrapped URL, header and Unicode body retain their exact values`, async () => {
    const url = "https://example.test/path?" + "dup=a%2Fb&dup=&empty&".repeat(25);
    const value = 'quoted "value"; backslash \\\\ '.repeat(20);
    const text = 'text "with quotes" and \u00e9 \u{1f680}\n\u0000'.repeat(15);
    for (const lineWidth of [40, 160]) {
      const { calls } = await run(
        format,
        [
          entry(
            {
              url,
              method: "POST",
              headers: [{ name: "X-Long", value }],
              bodySize: Buffer.byteLength(text),
            },
            { _rawRequestBody: text }
          ),
        ],
        { lineWidth }
      );
      assert.equal(calls[0].url, url);
      assert.deepEqual(calls[0].rawHeaders, [["X-Long", value]]);
      assert.deepEqual(calls[0].body, Buffer.from(text));
    }
  });

  test(`${format}: invalid inputs are rejected`, () => {
    assert.throws(() => RequestCode.serialize(format, []), /at least one/);
    assert.throws(() => RequestCode.serialize(format, [{}]), /HTTP/);
    assert.throws(
      () => RequestCode.serialize(format, [entry({ url: "ftp://example.test/" })]),
      /HTTP/
    );
    assert.throws(() => RequestCode.serialize(format, [entry({ url: "" })]), /HTTP/);
    assert.throws(() => RequestCode.serialize(format, [{ _record: {} }]), /HTTP/);
    // One bad entry fails the whole batch rather than producing partial code.
    assert.throws(
      () => RequestCode.serialize(format, [entry(), entry({ bodySize: 5, method: "POST" })]),
      /not captured/
    );
  });
}

test("serialize rejects unknown format", () => {
  assert.throws(() => RequestCode.serialize("nope", [entry()]), /Unknown/);
});

test("long header values stay on one line in every format, at any width", () => {
  // A User-Agent-like value under a custom name, since browser fetch drops User-Agent itself.
  const agent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
  const request = entry({ headers: [{ name: "X-Client-Agent", value: agent }] });
  // cURL (cmd) is a single encoded launcher line, so it has nothing to split.
  for (const { value: format } of RequestCode.FORMATS.filter(({ value }) => value !== "curl-cmd")) {
    for (const lineWidth of [40, 88]) {
      const code = RequestCode.serialize(format, [request], { lineWidth });
      assert.ok(
        code.split("\n").some((line) => line.includes(agent)),
        `${format} at ${lineWidth} must keep the User-Agent whole:\n${code}`
      );
    }
  }
});

test("long JSON string values stay on one line in Python and fetch structures", () => {
  const page =
    "https://github.com/octocat/hello-world/pull/42/files?diff=split&w=1#diff-" + "a".repeat(40);
  const body = JSON.stringify({ events: [{ page, title: "short" }], ref: page });
  const request = entry(
    {
      method: "POST",
      headers: [{ name: "Content-Type", value: "text/plain;charset=UTF-8" }],
      bodySize: body.length,
    },
    { _rawRequestBody: body }
  );
  const variants = [
    ["python", { pythonLibrary: "httpx" }],
    ["python", { pythonLibrary: "requests" }],
    ["fetch", {}],
    ["node-fetch", {}],
  ];
  for (const [format, options] of variants) {
    for (const lineWidth of [40, 88]) {
      const code = RequestCode.serialize(format, [request], { ...options, lineWidth });
      const lines = code.split("\n").filter((line) => line.includes(page));
      const label = format + (options.pythonLibrary ? ` (${options.pythonLibrary})` : "");
      assert.equal(
        lines.length,
        2,
        `${label} at ${lineWidth} must keep both values whole:\n${code}`
      );
    }
  }
});

test("python: the pythonLibrary option picks the package, defaulting to requests", () => {
  const request = entry({ url: "https://example.test/x" });
  const call = (options) => RequestCode.serialize("python", [request], options).split("(")[0];
  assert.equal(call(), "response = requests.get");
  assert.equal(call({ pythonLibrary: "requests" }), "response = requests.get");
  assert.equal(call({ pythonLibrary: "httpx" }), "response = httpx.get");
  assert.equal(call({ pythonLibrary: "urllib" }), "response = requests.get");
  assert.throws(() => RequestCode.serialize("python-httpx", [request]), /Unknown Copy as format/);
});

test("node-fetch: cookies from record become a Cookie header, existing Cookie not duplicated", async () => {
  const fromRecord = await run("node-fetch", [
    entry({
      cookies: [
        { name: "a", value: "1" },
        { name: "b", value: "x=y z" },
      ],
    }),
  ]);
  assert.deepEqual(fromRecord.calls[0].rawHeaders, [["Cookie", "a=1; b=x=y z"]]);
  const existing = await run("node-fetch", [
    entry({ headers: [{ name: "cookie", value: "own=1" }], cookies: [{ name: "a", value: "1" }] }),
  ]);
  assert.deepEqual(existing.calls[0].rawHeaders, [["cookie", "own=1"]]);
});

test("node-fetch: forbidden-in-browser headers are kept and no credentials mode is set", async () => {
  const { calls } = await run("node-fetch", [
    entry({
      headers: [
        { name: "User-Agent", value: "UA/1" },
        { name: "Referer", value: "https://r.test/" },
        { name: "Sec-Fetch-Mode", value: "cors" },
        { name: "Origin", value: "https://o.test" },
      ],
    }),
  ]);
  assert.deepEqual(
    calls[0].rawHeaders.map(([n]) => n),
    ["User-Agent", "Referer", "Sec-Fetch-Mode", "Origin"]
  );
  assert.equal(calls[0].credentials, undefined);
});

test("fetch: browser-managed headers are dropped, credentials included, session note emitted", async () => {
  const { code, calls } = await run("fetch", [
    entry({
      headers: [
        { name: "User-Agent", value: "UA/1" },
        { name: "Cookie", value: "own=1" },
        { name: "Referer", value: "https://r.test/" },
        { name: "Origin", value: "https://o.test" },
        { name: "Sec-Fetch-Mode", value: "cors" },
        { name: "sec-ch-ua", value: "x" },
        { name: "Proxy-Authorization", value: "p" },
        { name: "Authorization", value: "Bearer t" },
        { name: "X-Custom", value: "v" },
      ],
      cookies: [{ name: "a", value: "1" }],
    }),
  ]);
  assert.deepEqual(calls[0].rawHeaders, [
    ["Authorization", "Bearer t"],
    ["X-Custom", "v"],
  ]);
  assert.equal(calls[0].credentials, "include");
  assert.match(
    code,
    /^\/\//,
    "dropping headers must leave a leading comment about the browser session"
  );
});

test("fetch: no session note when nothing was dropped", () => {
  const code = RequestCode.serialize("fetch", [
    entry({ headers: [{ name: "X-Custom", value: "v" }] }),
  ]);
  assert.doesNotMatch(code, /^\/\//);
});

test("fetch: captured cookies alone do not add a Cookie header", async () => {
  const { calls } = await run("fetch", [entry({ cookies: [{ name: "a", value: "1" }] })]);
  assert.deepEqual(calls[0].rawHeaders, []);
  assert.equal(calls[0].credentials, "include");
});

test("normalize: pure output, header order and method default", () => {
  const request = {
    url: "https://example.test/x",
    headers: [
      { name: "B", value: "2" },
      { name: ":path", value: "/x" },
      { name: "A", value: "1" },
    ],
    cookies: [],
    bodySize: 0,
  };
  const result = RequestCode.normalize({ _record: { request } });
  assert.equal(result.method, "GET");
  assert.deepEqual(
    [...result.headers.map((h) => [...h])],
    [
      ["B", "2"],
      ["A", "1"],
    ]
  );
  assert.equal(result.body, null);
  // Input is not mutated.
  assert.equal(request.headers.length, 3);
});

test("normalize: text and base64 body shapes", () => {
  const text = RequestCode.normalize(
    entry({ method: "POST", bodySize: 3 }, { _rawRequestBody: "h\u00e9" })
  );
  assert.equal(text.body.text, "h\u00e9");
  assert.deepEqual([...text.body.bytes], [0x68, 0xc3, 0xa9]);
  const bin = RequestCode.normalize(
    entry(
      { method: "POST", bodySize: 2, bodyEncoding: "base64" },
      { _rawRequestBody: Buffer.from([0, 255]).toString("base64") }
    )
  );
  assert.equal(bin.body.text, null);
  assert.deepEqual([...bin.body.bytes], [0, 255]);
});

// Windows-only consumer test: runs the generated curl-cmd through cmd.exe against a loopback
// receiver, so launcher quoting and stdin encoding (e.g. a UTF-8 BOM) are exercised for real.
function toolAvailable(command, args) {
  const result = require("node:child_process").spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15000,
  });
  return !result.error && result.status === 0;
}
const canRunCurlCmd =
  process.platform === "win32" &&
  toolAvailable("curl.exe", ["--version"]) &&
  toolAvailable("powershell.exe", ["-NoProfile", "-Command", "exit 0"]);

test(
  "curl-cmd preserves literal URLs, binary bytes and HEAD response semantics",
  {
    skip: canRunCurlCmd ? false : "requires Windows with curl.exe and powershell.exe",
    timeout: 60000,
  },
  async () => {
    const http = require("node:http");
    const { exec } = require("node:child_process");
    const execute = (code) =>
      new Promise((resolve, reject) => {
        const child = exec(
          code,
          { shell: "cmd.exe", windowsHide: true, timeout: 20000 },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve()
        );
        child.stdin.end();
      });
    const payload = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          body: Buffer.concat(chunks),
        });
        res.end("ok");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const url = `http://127.0.0.1:${server.address().port}/p%20a/b?q=%25PATH%25&r=!x!&list[0]=one&group={a,b}`;
      const code = RequestCode.serialize("curl-cmd", [
        entry(
          {
            url,
            method: "POST",
            headers: [{ name: "X-Probe", value: "a%PATH%b!x!^&|" }],
            bodySize: 256,
            bodyMimeType: "application/octet-stream",
            bodyEncoding: "base64",
          },
          { _rawRequestBody: payload.toString("base64") }
        ),
      ]).trim();
      await execute(code);
      assert.equal(received.length, 1);
      const [got] = received;
      assert.equal(got.method, "POST");
      assert.equal(got.url, new URL(url).pathname + new URL(url).search);
      const headers = [];
      for (let i = 0; i < got.rawHeaders.length; i += 2)
        headers.push([got.rawHeaders[i].toLowerCase(), got.rawHeaders[i + 1]]);
      assert.deepEqual(
        headers.find(([n]) => n === "x-probe"),
        ["x-probe", "a%PATH%b!x!^&|"]
      );
      assert.deepEqual(
        headers.find(([n]) => n === "content-type"),
        ["content-type", "application/octet-stream"]
      );
      assert.ok(
        got.body.equals(payload),
        `body mismatch: got ${got.body.length} bytes starting ${got.body.subarray(0, 4).toString("hex")}`
      );
      await execute(RequestCode.serialize("curl-cmd", [entry({ url, method: "HEAD" })]).trim());
      assert.equal(received.length, 2);
      assert.equal(received[1].method, "HEAD");
      assert.equal(received[1].url, new URL(url).pathname + new URL(url).search);
      assert.deepEqual(received[1].body, Buffer.alloc(0));
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test("incomplete postData metadata cannot become an empty replay", () => {
  assert.throws(
    () =>
      RequestCode.serialize("node-fetch", [
        entry(
          { method: "POST", bodySize: undefined },
          { _requestPostData: { mimeType: "text/plain", params: [] } }
        ),
      ]),
    /not captured/
  );
  // An explicit zero size stays body-less.
  const { body } = RequestCode.normalize(
    entry(
      { method: "POST", bodySize: 0 },
      { _requestPostData: { mimeType: "text/plain", params: [] } }
    )
  );
  assert.equal(body, null);
});

test("oversized cmd requests fail clearly while Node fetch preserves their bytes", async () => {
  const big = Buffer.alloc(5000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const record = () =>
    entry(
      {
        method: "POST",
        bodySize: big.length,
        bodyMimeType: "application/octet-stream",
        bodyEncoding: "base64",
      },
      { _rawRequestBody: big.toString("base64") }
    );
  assert.throws(
    () => RequestCode.serialize("curl-cmd", [record()]),
    /length limit|8191|Choose another/i
  );
  const { calls } = await run("node-fetch", [record()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, big);
});

// -- cURL (bash) --
// Text bodies are one inline `--data-raw` word; only binary (and very large) bodies are piped
// through printf. The consumer tests run the generated script in a real bash against a loopback
// server. On Windows only Git Bash is used (WSL cannot reach the host's 127.0.0.1).

function findBashWithCurl() {
  const candidates = [];
  if (process.platform === "win32") {
    for (const root of [
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ]) {
      if (root) candidates.push(path.join(root, "Git", "bin", "bash.exe"));
    }
  } else {
    candidates.push("bash");
  }
  return (
    candidates.find(
      (bash) =>
        (process.platform !== "win32" || fs.existsSync(bash)) &&
        toolAvailable(bash, ["-c", "curl --version"])
    ) || null
  );
}
const nativeBash = findBashWithCurl();
const bashSkip = nativeBash
  ? false
  : "requires bash and curl (Git Bash on Windows; WSL is not used)";

const curlBashOf = (request, body, options) =>
  RequestCode.serialize("curl-bash", [entry(request, body)], options).trimEnd();

test("curl-bash sends text bodies inline with --data-raw and no printf", () => {
  const body = JSON.stringify({ client_id: "108510486.1776712490", note: "it's $HOME `id`" });
  const code = curlBashOf(
    {
      url: "https://collector.github.com/github/collect",
      method: "POST",
      headers: [{ name: "Content-Type", value: "text/plain;charset=UTF-8" }],
      bodySize: body.length,
    },
    { _rawRequestBody: body }
  );
  assert.equal(
    code,
    [
      "curl --globoff \\",
      "  --url 'https://collector.github.com/github/collect' \\",
      "  --header 'Content-Type: text/plain;charset=UTF-8' \\",
      "  --data-raw '" + body.replace(/'/g, "'\\''") + "'",
    ].join("\n")
  );
  assert.doesNotMatch(code, /printf|--data-binary|--request/);
});

test("curl-bash writes control characters as an ANSI-C $'...' word on one line", () => {
  const body = "a\r\nb\tc\\d'e!f\u00e9\u200d\"$x`";
  const code = curlBashOf(
    { method: "POST", headers: [{ name: "Content-Type", value: "text/plain" }], bodySize: 9 },
    { _rawRequestBody: body }
  );
  const dataLine = code.split("\n").find((line) => line.includes("--data-raw"));
  assert.equal(dataLine, "  --data-raw $'a\\r\\nb\\tc\\\\d\\'e\\x21f\u00e9\\xe2\\x80\\x8d\"$x`'");
  assert.doesNotMatch(code, /printf/);
});

test("curl-bash keeps binary and oversized bodies on the exact printf path", () => {
  const binary = entry(
    {
      method: "POST",
      bodySize: 3,
      bodyMimeType: "application/octet-stream",
      bodyEncoding: "base64",
    },
    { _rawRequestBody: Buffer.from([0x41, 0x00, 0xff]).toString("base64") }
  );
  const code = RequestCode.serialize("curl-bash", [binary]);
  assert.match(code, /^printf '%b' \\\n {2}'\\x41\\x00\\xff' \|\ncurl /);
  assert.match(code, /--data-binary '@-'/);
  assert.doesNotMatch(code, /--data-raw/);
  const big = "x".repeat(30000);
  const oversized = curlBashOf({ method: "POST", bodySize: big.length }, { _rawRequestBody: big });
  assert.match(oversized, /^printf '%b'/);
  assert.match(oversized, /--data-binary '@-'/);
});

test("curl-bash omits redundant --request and keeps needed ones", () => {
  assert.doesNotMatch(curlBashOf({}), /--request/);
  const put = curlBashOf({ method: "PUT", bodySize: 1 }, { _rawRequestBody: "x" });
  assert.match(put, /--request 'PUT'/);
  const lower = curlBashOf({ method: "post", bodySize: 1 }, { _rawRequestBody: "x" });
  assert.match(lower, /--request 'post'/);
  const getBody = curlBashOf({ method: "GET", bodySize: 1 }, { _rawRequestBody: "x" });
  assert.match(getBody, /--request 'GET'/);
  const post = curlBashOf({ method: "POST" });
  assert.match(post, /--request 'POST'/);
  const head = curlBashOf({ method: "HEAD" });
  assert.match(head, /--head/);
  assert.doesNotMatch(head, /printf|--request/);
});

test("curl-bash empties curl's default Content-Type when none was captured", () => {
  const code = curlBashOf({ method: "POST", bodySize: 5 }, { _rawRequestBody: "hello" });
  assert.match(code, /--header 'Content-Type:' \\\n {2}--data-raw 'hello'$/);
  const typed = curlBashOf(
    { method: "POST", headers: [{ name: "content-type", value: "a/b" }], bodySize: 5 },
    { _rawRequestBody: "hello" }
  );
  assert.doesNotMatch(typed, /'Content-Type:'/);
});

test(
  "curl-bash replays exact bodies, methods and Content-Type through bash and curl",
  { skip: bashSkip, timeout: 120000 },
  async () => {
    const http = require("node:http");
    const os = require("node:os");
    const { spawn } = require("node:child_process");
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        res.end("ok");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curl-bash-"));
    const script = path.join(dir, "replay.sh");
    const execute = (code) =>
      new Promise((resolve, reject) => {
        fs.writeFileSync(script, code + "\n");
        const child = spawn(nativeBash, ["replay.sh"], {
          cwd: dir,
          env: { ...process.env, MSYS_NO_PATHCONV: "1", LC_ALL: "C" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        const timer = setTimeout(() => child.kill(), 30000);
        child.on("close", (status) => {
          clearTimeout(timer);
          status === 0 ? resolve() : reject(new Error(`bash exited ${status}\n${output}\n${code}`));
        });
      });
    try {
      const url = `http://127.0.0.1:${server.address().port}/collect?a=1&b=%20x`;
      const replay = async (request, extra, expected) => {
        const code = curlBashOf({ url, ...request }, extra);
        received.length = 0;
        await execute(code);
        assert.equal(received.length, 1, code);
        const [got] = received;
        assert.equal(got.method, request.method, code);
        assert.equal(got.url, "/collect?a=1&b=%20x");
        assert.ok(
          got.body.equals(expected.body),
          `body mismatch: got ${JSON.stringify(got.body.toString("latin1"))}\n${code}`
        );
        assert.equal(got.headers["content-type"], expected.contentType, code);
        return { code, got };
      };
      const textType = { name: "Content-Type", value: "text/plain;charset=UTF-8" };
      const sized = (value) => Buffer.byteLength(value);

      // Collector-style JSON with quotes, dollar signs, backticks, command substitution,
      // backslashes and non-ASCII text, plus a leading @ that must not become a file read.
      const json = JSON.stringify({
        client_id: "108510486.1776712490",
        events: [
          {
            name: 'it\'s "quoted" $HOME `id` $(id) \\n \\ ${PATH} !! caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00',
            file: "@package.json",
          },
        ],
      });
      const collector = await replay(
        { method: "POST", headers: [textType], bodySize: sized(json) },
        { _rawRequestBody: json },
        { body: Buffer.from(json), contentType: "text/plain;charset=UTF-8" }
      );
      assert.doesNotMatch(collector.code, /printf/);
      await replay(
        { method: "POST", headers: [textType], bodySize: 1 },
        { _rawRequestBody: "@package.json" },
        { body: Buffer.from("@package.json"), contentType: "text/plain;charset=UTF-8" }
      );

      // Multi-line text with CRLF, tabs and an invisible format character.
      const lines = "line1\r\n\tindented 'one'\r\n\r\nlast\u200d\n!tail\\n";
      const multi = await replay(
        { method: "POST", headers: [textType], bodySize: sized(lines) },
        { _rawRequestBody: lines },
        { body: Buffer.from(lines), contentType: "text/plain;charset=UTF-8" }
      );
      assert.match(multi.code, /--data-raw \$'/);
      assert.doesNotMatch(multi.code, /printf/);

      // No captured Content-Type: curl must not add its form-urlencoded default.
      const bare = await replay(
        { method: "POST", bodySize: 5 },
        { _rawRequestBody: "hello" },
        { body: Buffer.from("hello"), contentType: undefined }
      );
      assert.doesNotMatch(bare.code, /printf/);

      const form = "a=1&b=%C3%A9&c=x+y&d=%24%27";
      await replay(
        {
          method: "POST",
          headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
          bodySize: form.length,
        },
        { _rawRequestBody: form },
        { body: Buffer.from(form), contentType: "application/x-www-form-urlencoded" }
      );

      await replay(
        { method: "PUT", headers: [textType], bodySize: 2 },
        { _rawRequestBody: "{}" },
        { body: Buffer.from("{}"), contentType: "text/plain;charset=UTF-8" }
      );

      // An empty text body is still a POST with Content-Length 0.
      const empty = await replay(
        { method: "POST", headers: [textType], bodySize: 0 },
        { _rawRequestBody: "" },
        { body: Buffer.alloc(0), contentType: "text/plain;charset=UTF-8" }
      );
      assert.equal(empty.got.headers["content-length"], "0");

      // Binary bodies still replay byte-for-byte through printf.
      const payload = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) payload[i] = i;
      const binary = await replay(
        {
          method: "POST",
          bodySize: 256,
          bodyMimeType: "application/octet-stream",
          bodyEncoding: "base64",
        },
        { _rawRequestBody: payload.toString("base64") },
        { body: payload, contentType: "application/octet-stream" }
      );
      assert.match(binary.code, /^printf '%b'/);

      // Text too large for one argument is piped but stays exact.
      const big = "line \u00e9 $x\n".repeat(3000);
      const bigPiped = await replay(
        { method: "POST", headers: [textType], bodySize: sized(big) },
        { _rawRequestBody: big },
        { body: Buffer.from(big), contentType: "text/plain;charset=UTF-8" }
      );
      assert.match(bigPiped.code, /^printf '%b'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

// -- PowerShell bodies --

const psOf = (request, extra, options) =>
  RequestCode.serialize("powershell", [entry({ method: "POST", ...request }, extra)], options);
const psType = (value) => ({ name: "Content-Type", value });

// A collector-style beacon: nested JSON strings, ints, doubles, booleans, null, empty containers,
// non-ASCII text and both quote characters.
const psCollector = JSON.stringify({
  client_id: "1234567890.1730000000",
  engagement_time_msec: 100,
  ratio: 51.1,
  weight: 1.25,
  whole: "WHOLE",
  flags: { visible: true, hidden: false, nothing: null },
  empty: { list: [], map: {}, nested: [[]], pair: [[1, 2]] },
  events: [
    {
      name: "page_view",
      params: JSON.stringify({ a: [1, 2.5], who: "it's", quote: 'say "hi"' }),
      title:
        'it\'s "quoted" $HOME `id` \\ caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 <b>&amp;</b> a/b',
    },
  ],
}).replace('"WHOLE"', "1.0");

test("powershell: text bodies are readable UTF-8 text, never base64", () => {
  const text = psOf(
    { headers: [psType("text/plain")], bodySize: 3 },
    { _rawRequestBody: "a=1&b='x'" }
  );
  assert.match(text, /\$body = \[Text\.Encoding\]::UTF8\.GetBytes\('a=1&b=''x'''\)/);
  assert.doesNotMatch(text, /FromBase64String/);
  const multi = psOf(
    { headers: [psType("text/plain")], bodySize: 9 },
    { _rawRequestBody: "l1\r\n\tl2 $x `y\n" }
  );
  assert.ok(multi.includes('GetBytes("l1`r`n`tl2 `$x ``y`n")'), multi);
  assert.ok(!/[\r\t]/.test(multi), "script holds no raw CR or tab");
  const unicode = psOf(
    { headers: [psType("text/plain")], bodySize: 9 },
    { _rawRequestBody: "caf\u00e9 \ud83d\ude00 \u201cq\u201d" }
  );
  assert.ok(unicode.includes('GetBytes("caf`u{e9} `u{1f600} `u{201c}q`u{201d}")'), unicode);
  assert.ok(/^[\x20-\x7e\n]*$/.test(unicode), "script stays ASCII");
});

test("powershell: JSON bodies become ordered structures sent through ConvertTo-Json", () => {
  const code = psOf(
    { headers: [psType("text/plain;charset=UTF-8")], bodySize: psCollector.length },
    { _rawRequestBody: psCollector },
    { lineWidth: 80 }
  );
  assert.doesNotMatch(code, /FromBase64String/);
  assert.match(code, /^\$payload = \[ordered\]@\{$/m);
  assert.match(code, /^ {4}client_id = '1234567890\.1730000000'$/m);
  assert.match(code, /^ {4}ratio = 51\.1$/m);
  assert.match(code, /^ {8}visible = \$true$|visible = \$true/m);
  assert.match(code, /nothing = \$null/);
  assert.match(code, /list = @\(\)/);
  assert.match(code, /map = \[ordered\]@\{\}/);
  assert.match(code, /nested = @\(,@\(\)\)/);
  assert.match(code, /pair = @\(,@\(1, 2\)\)/);
  assert.match(
    code,
    /params = \(ConvertTo-Json -Compress -Depth 100 -InputObject \(\[ordered\]@\{/
  );
  assert.match(code, /\$json = ConvertTo-Json -Compress -Depth 100 -InputObject \$payload\n/);
  assert.match(code, /\$body = \[Text\.Encoding\]::UTF8\.GetBytes\(\$json\)\n/);
  assert.match(code, /ContentType = 'text\/plain;charset=UTF-8'/);
  assert.ok(
    code.startsWith(
      "if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'This request needs PowerShell 7 or later.' }\n"
    ),
    code
  );
});

test("powershell: JSON that ConvertTo-Json would rewrite stays exact text", () => {
  for (const body of [
    '{"a": 1}',
    '{"a":1e-7}',
    '{"a":1E5}',
    '{"a":12345678901234567890}',
    '{"a":0.00001}',
    '{"a":1.50}',
    '{"a":-0}',
    '{"A":1,"a":2}',
    '{"\u00e9":1,"\u00c9":2}',
    '{"a":"\u0085"}',
    '{"a":"\\u0041"}',
    '{"a":"\\u007f"}',
    '{"a":"\\/"}',
    '{"__proto__":1,"a":1,"a":2}',
    "[1,2]\n",
    '{"a":"\\ud800"}',
  ]) {
    const code = psOf({ headers: [psType("text/plain")], bodySize: 1 }, { _rawRequestBody: body });
    assert.doesNotMatch(code, /ConvertTo-Json|FromBase64String/, body);
    assert.match(code, /\$body = \[Text\.Encoding\]::UTF8\.GetBytes\(/, body);
  }
});

test("powershell: exactly modelled numbers, strings and keys stay structures", () => {
  const code = psOf(
    { headers: [psType("text/plain")], bodySize: 1 },
    {
      _rawRequestBody:
        '{"int":9223372036854775807,"neg":-5,"zero":0,"dbl":0.0001,"whole":2.0,"A":"\\u2028\\u2029\\u0085<>&\'/\\\\",' +
        '"if":[null,[],{}],"a b":[[[1]]],"":false}',
    }
  );
  assert.match(code, /ConvertTo-Json/);
  assert.match(code, /int = 9223372036854775807/);
  assert.match(code, /whole = 2\.0/);
  assert.match(code, /if = @\(\$null, @\(\), \[ordered\]@\{\}\)/);
  assert.match(code, /'a b' = @\(,@\(,@\(1\)\)\)/);
  assert.match(code, / {4}'' = \$false/);
});

test("powershell: string values and header values are never split, even at width 40", () => {
  const page =
    "https://github.com/octocat/hello-world/pull/42/files?diff=split&w=1#diff-" + "a".repeat(40);
  const body = JSON.stringify({ events: [{ page, title: "short" }], ref: page });
  const code = psOf(
    { headers: [psType("text/plain"), { name: "X-Long", value: page }], bodySize: body.length },
    { _rawRequestBody: body },
    { lineWidth: 40 }
  );
  assert.equal(code.split(`'${page}'`).length - 1, 3, "two body values and one header, whole");
  assert.match(code, /^ {4}'X-Long' = /m);
});

test("powershell: long raw text wraps at the line width on exact boundaries", () => {
  const text = ("plain words, with 'quotes' & \u00e9 symbols\r\n" + "x".repeat(70) + "\n").repeat(
    3
  );
  const code = psOf(
    { headers: [psType("text/plain")], bodySize: text.length },
    { _rawRequestBody: text },
    { lineWidth: 60 }
  );
  assert.doesNotMatch(code, /FromBase64String/);
  const bodyLines = code.slice(code.indexOf("$body"), code.indexOf("$params")).split("\n");
  assert.equal(bodyLines[0], "$body = [Text.Encoding]::UTF8.GetBytes(");
  assert.ok(bodyLines.length > 4);
  for (const line of bodyLines.slice(1, -3)) assert.match(line, / \+$/);
  assert.ok(Math.max(...bodyLines.map((line) => line.length)) <= 64, "pieces fit the width");
});

test("powershell: binary bodies keep the base64 path", () => {
  const bytes = Buffer.from([0, 255, 254, 128, 10, 13]);
  const code = psOf(
    { bodySize: 6, bodyMimeType: "application/octet-stream", bodyEncoding: "base64" },
    { _rawRequestBody: bytes.toString("base64") }
  );
  assert.match(code, /\$body = \[Convert\]::FromBase64String\('AP/);
  assert.doesNotMatch(code, /UTF8\.GetBytes/);
  const control = psOf(
    { headers: [psType("text/plain")], bodySize: 3 },
    { _rawRequestBody: "a\u0000b" }
  );
  assert.match(control, /FromBase64String/);
});

// Native consumer test: runs generated snippets in PowerShell 7 against a loopback receiver. Every
// body must arrive byte for byte with its exact Content-Type, whatever the script's line endings.
const canRunPowerShell7 = toolAvailable("pwsh", [
  "-NoProfile",
  "-Command",
  "exit $(if ($PSVersionTable.PSVersion.Major -ge 7) { 0 } else { 1 })",
]);

test(
  "powershell sends exact text, JSON and binary bodies natively in PowerShell 7",
  { skip: canRunPowerShell7 ? false : "requires PowerShell 7 (pwsh) on PATH", timeout: 180000 },
  async () => {
    const http = require("node:http");
    const os = require("node:os");
    const { spawn } = require("node:child_process");
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        res.end("ok");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powershell-body-"));
    const execute = (code, name) =>
      new Promise((resolve, reject) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, code);
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        const timer = setTimeout(() => child.kill(), 40000);
        child.on("close", (status) => {
          clearTimeout(timer);
          status === 0 ? resolve() : reject(new Error(`pwsh exited ${status}\n${output}\n${code}`));
        });
      });
    try {
      const url = `http://127.0.0.1:${server.address().port}/collect?a=1&b=%20x`;
      let count = 0;
      // Runs the snippet with LF and with CRLF line endings; both must send the same bytes.
      const replay = async (request, extra, expected, options) => {
        const code = psOf({ url, ...request }, extra, options);
        for (const ending of ["\n", "\r\n"]) {
          received.length = 0;
          await execute(code.replace(/\n/g, ending), `replay-${count++}.ps1`);
          assert.equal(received.length, 1, code);
          const [got] = received;
          assert.equal(got.method, request.method ?? "POST", code);
          assert.equal(got.url, "/collect?a=1&b=%20x");
          assert.ok(
            got.body.equals(expected.body),
            `body mismatch (${JSON.stringify(ending)}): got ${JSON.stringify(got.body.toString("latin1"))}\n${code}`
          );
          // Invoke-WebRequest -ContentType re-spaces parameters ("a;b=c" becomes "a; b=c").
          assert.equal(
            got.headers["content-type"],
            expected.contentType?.replace(/;\s*/g, "; "),
            code
          );
        }
        return code;
      };
      const textType = psType("text/plain;charset=UTF-8");
      const sized = (value) => Buffer.byteLength(value);
      const textExpect = (value) => ({
        body: Buffer.from(value),
        contentType: "text/plain;charset=UTF-8",
      });

      // Collector-style JSON rebuilt from structures (and at a narrow width, so every wrapping
      // path runs): nested JSON strings, numbers, booleans, null, empty containers, non-ASCII.
      for (const lineWidth of [120, 40]) {
        const collector = await replay(
          { headers: [textType], bodySize: sized(psCollector) },
          { _rawRequestBody: psCollector },
          textExpect(psCollector),
          { lineWidth }
        );
        assert.match(collector, /ConvertTo-Json/);
        assert.doesNotMatch(collector, /FromBase64String/);
      }

      // Non-exact JSON: extra spaces, a big integer and 1e-7 are sent as text, unchanged.
      for (const odd of [
        '{ "a": 1,  "b": [1, 2] }',
        '{"id":12345678901234567890,"n":1}',
        '{"tiny":1e-7,"x":1.50}',
        '{"k":"\\u00e9\\/","A":1,"a":2}',
      ]) {
        const code = await replay(
          { headers: [textType], bodySize: sized(odd) },
          { _rawRequestBody: odd },
          textExpect(odd)
        );
        assert.doesNotMatch(code, /ConvertTo-Json|FromBase64String/, odd);
      }

      // Multi-line text with CRLF, tabs, quotes, expansion characters and non-ASCII.
      const lines =
        "line1\r\n\tindented 'one' \"two\"\r\n\r\n$x $(id) `n @{a=1} caf\u00e9 \ud83d\ude00 \u201cq\u201d\u200d\n" +
        "last\\n\n" +
        "w".repeat(150) +
        "\r\n";
      for (const lineWidth of [120, 40]) {
        await replay(
          { headers: [textType], bodySize: sized(lines) },
          { _rawRequestBody: lines },
          textExpect(lines),
          { lineWidth }
        );
      }
      const bom = "\ufeffBOM text";
      await replay(
        { headers: [textType], bodySize: sized(bom) },
        { _rawRequestBody: bom },
        textExpect(bom)
      );

      // Form-urlencoded text, an empty body, and a captured body without Content-Type.
      const form = "a=1&b=%C3%A9&c=x+y&d=%24%27&e=";
      await replay(
        { headers: [psType("application/x-www-form-urlencoded")], bodySize: form.length },
        { _rawRequestBody: form },
        { body: Buffer.from(form), contentType: "application/x-www-form-urlencoded" }
      );
      await replay({ headers: [textType], bodySize: 0 }, { _rawRequestBody: "" }, textExpect(""));

      // Binary bodies: every byte value, through base64.
      const payload = Buffer.alloc(512);
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
      const binary = await replay(
        {
          bodySize: payload.length,
          bodyMimeType: "application/octet-stream",
          bodyEncoding: "base64",
        },
        { _rawRequestBody: payload.toString("base64") },
        { body: payload, contentType: "application/octet-stream" }
      );
      assert.match(binary, /FromBase64String/);
      const control = "a\u0000b\u0001\r\n";
      const controlCode = await replay(
        { headers: [textType], bodySize: control.length },
        { _rawRequestBody: control },
        textExpect(control)
      );
      assert.match(controlCode, /FromBase64String/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);
