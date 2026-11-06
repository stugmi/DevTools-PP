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
