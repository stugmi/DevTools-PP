// Behavior tests for scripts/release/chrome-web-store.js against a real local HTTP server.
// Run with `bun test tests/test-chrome-web-store.js`. Uses throwaway RSA keys only.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { packageRelease } = require("../scripts/release/package-release");
const { uploadRelease } = require("../scripts/release/chrome-web-store");

const TOKEN = "ya29.test-secret-token";
const PUBLISHER = "pub123";
const ITEM = "abcdefghijklmnopabcdefghijklmnop";
const ITEM_PATH = `publishers/${PUBLISHER}/items/${ITEM}`;

async function makePackage(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cws-test-"));
  const distDir = path.join(root, "dist");
  const outputDir = path.join(root, "out");
  fs.mkdirSync(distDir);
  fs.writeFileSync(
    path.join(distDir, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "fixture", version })
  );
  fs.writeFileSync(path.join(distDir, "a.js"), "console.log(1);");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  await packageRelease({ distDir, outputDir, version, privateKeyPem });
  const release = JSON.parse(fs.readFileSync(path.join(outputDir, "release.json"), "utf8"));
  return {
    root,
    crx: path.join(outputDir, "devtools-plus-plus.crx"),
    keySha: release.signingKeySha256,
  };
}

// handlers: { fetchStatus: [..responses], upload: resp, publish: resp }. Arrays are consumed in
// order and the last entry repeats. A response is { status?, json }.
async function withServer(handlers, run) {
  const requests = [];
  const counters = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url;
      const op = url.endsWith(":fetchStatus")
        ? "fetchStatus"
        : url.endsWith(":upload")
          ? "upload"
          : url.endsWith(":publish")
            ? "publish"
            : "unknown";
      requests.push({
        op,
        method: req.method,
        url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      let spec = handlers[op];
      if (Array.isArray(spec)) {
        const n = counters[op] || 0;
        counters[op] = n + 1;
        spec = spec[Math.min(n, spec.length - 1)];
      }
      if (!spec) spec = { status: 404, json: { error: "unexpected" } };
      res.writeHead(spec.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(spec.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ apiBase, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function options(pkg, apiBase, extra = {}) {
  let clock = 0;
  return {
    file: pkg.crx,
    version: "1.5.3",
    expectedKeySha256: pkg.keySha,
    publisherId: PUBLISHER,
    itemId: ITEM,
    accessToken: TOKEN,
    apiBase,
    log: () => {},
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...extra,
  };
}

const idleStatus = {
  json: {
    publishedItemRevisionStatus: {
      state: "PUBLISHED",
      distributionChannels: [{ deployPercentage: 100, crxVersion: "1.5.2" }],
    },
  },
};
const uploadOk = {
  json: { name: ITEM_PATH, itemId: ITEM, crxVersion: "1.5.3", uploadState: "SUCCEEDED" },
};
const publishOk = { json: { name: ITEM_PATH, itemId: ITEM, state: "PENDING_REVIEW" } };

test("upload mode sends the exact signed CRX and never publishes", async () => {
  const pkg = await makePackage("1.5.3");
  await withServer({ fetchStatus: idleStatus, upload: uploadOk }, async ({ apiBase, requests }) => {
    const result = await uploadRelease(options(pkg, apiBase));
    assert.equal(result.outcome, "uploaded");
    assert.deepEqual(
      requests.map((r) => r.op),
      ["fetchStatus", "upload"]
    );
    const upload = requests[1];
    assert.equal(upload.method, "POST");
    assert.equal(upload.url, `/upload/v2/${ITEM_PATH}:upload`);
    assert.equal(upload.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(upload.headers["x-goog-upload-protocol"], "raw");
    assert.equal(upload.headers["content-type"], "application/octet-stream");
    assert.ok(upload.body.equals(fs.readFileSync(pkg.crx)));
  });
});

test("publish mode submits for review with DEFAULT_PUBLISH after upload", async () => {
  const pkg = await makePackage("1.5.3");
  await withServer(
    { fetchStatus: idleStatus, upload: uploadOk, publish: publishOk },
    async ({ apiBase, requests }) => {
      const result = await uploadRelease(options(pkg, apiBase, { mode: "publish" }));
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus", "upload", "publish"]
      );
      assert.deepEqual(JSON.parse(requests[2].body.toString()), {
        publishType: "DEFAULT_PUBLISH",
        skipReview: false,
        blockOnWarnings: true,
      });
      assert.equal(result.state, "PENDING_REVIEW");
    }
  );
});

test("async upload publishes only after lastAsyncUploadState SUCCEEDED", async () => {
  const pkg = await makePackage("1.5.3");
  const handlers = {
    fetchStatus: [
      idleStatus,
      { json: { ...idleStatus.json, lastAsyncUploadState: "IN_PROGRESS" } },
      { json: { ...idleStatus.json, lastAsyncUploadState: "SUCCEEDED" } },
    ],
    upload: { json: { name: ITEM_PATH, itemId: ITEM, uploadState: "IN_PROGRESS" } },
    publish: publishOk,
  };
  await withServer(handlers, async ({ apiBase, requests }) => {
    await uploadRelease(options(pkg, apiBase, { mode: "publish" }));
    assert.deepEqual(
      requests.map((r) => r.op),
      ["fetchStatus", "upload", "fetchStatus", "fetchStatus", "publish"]
    );
  });
});

test("async upload failure never publishes", async () => {
  const pkg = await makePackage("1.5.3");
  const handlers = {
    fetchStatus: [idleStatus, { json: { ...idleStatus.json, lastAsyncUploadState: "FAILED" } }],
    upload: { json: { uploadState: "IN_PROGRESS" } },
    publish: publishOk,
  };
  await withServer(handlers, async ({ apiBase, requests }) => {
    await assert.rejects(uploadRelease(options(pkg, apiBase, { mode: "publish" })), /FAILED/);
    assert.ok(!requests.some((r) => r.op === "publish"));
  });
});

test("async upload that never finishes times out without publishing", async () => {
  const pkg = await makePackage("1.5.3");
  const handlers = {
    fetchStatus: [
      idleStatus,
      { json: { ...idleStatus.json, lastAsyncUploadState: "IN_PROGRESS" } },
    ],
    upload: { json: { uploadState: "IN_PROGRESS" } },
    publish: publishOk,
  };
  await withServer(handlers, async ({ apiBase, requests }) => {
    await assert.rejects(
      uploadRelease(
        options(pkg, apiBase, { mode: "publish", pollIntervalMs: 1000, pollTimeoutMs: 3000 })
      ),
      /did not finish/
    );
    assert.ok(!requests.some((r) => r.op === "publish"));
    assert.ok(requests.filter((r) => r.op === "fetchStatus").length <= 5);
  });
});

test("rejected synchronous upload does not publish", async () => {
  const pkg = await makePackage("1.5.3");
  await withServer(
    { fetchStatus: idleStatus, upload: { json: { uploadState: "FAILED" } }, publish: publishOk },
    async ({ apiBase, requests }) => {
      await assert.rejects(
        uploadRelease(options(pkg, apiBase, { mode: "publish" })),
        /did not succeed/
      );
      assert.ok(!requests.some((r) => r.op === "publish"));
    }
  );
});

test("invalid CRX, wrong key pin or wrong version fail before any request", async () => {
  const pkg = await makePackage("1.5.3");
  const other = await makePackage("1.5.3");
  const tampered = path.join(pkg.root, "tampered.crx");
  const bytes = fs.readFileSync(pkg.crx);
  bytes[bytes.length - 3] ^= 0xff;
  fs.writeFileSync(tampered, bytes);
  await withServer(
    { fetchStatus: idleStatus, upload: uploadOk, publish: publishOk },
    async ({ apiBase, requests }) => {
      await assert.rejects(uploadRelease(options(pkg, apiBase, { file: tampered })));
      await assert.rejects(
        uploadRelease(options(pkg, apiBase, { expectedKeySha256: other.keySha }))
      );
      await assert.rejects(
        uploadRelease(options(pkg, apiBase, { version: "1.5.4" })),
        /does not match requested/
      );
      assert.equal(requests.length, 0);
    }
  );
});

test("preflight skips published same version and refuses downgrades", async () => {
  const pkg = await makePackage("1.5.3");
  const published = (v) => ({
    json: {
      publishedItemRevisionStatus: {
        state: "PUBLISHED",
        distributionChannels: [{ crxVersion: v }],
      },
    },
  });
  await withServer(
    { fetchStatus: published("1.5.3"), upload: uploadOk, publish: publishOk },
    async ({ apiBase, requests }) => {
      const result = await uploadRelease(options(pkg, apiBase, { mode: "publish" }));
      assert.equal(result.outcome, "already-published");
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus"]
      );
    }
  );
  // Numeric, not lexical: 1.10.0 is newer than 1.5.3.
  await withServer(
    { fetchStatus: published("1.10.0"), upload: uploadOk },
    async ({ apiBase, requests }) => {
      await assert.rejects(uploadRelease(options(pkg, apiBase)), /downgrade/);
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus"]
      );
    }
  );
});

test("active submissions are never replaced", async () => {
  const pkg = await makePackage("1.5.3");
  const pending = (v, state = "PENDING_REVIEW") => ({
    json: {
      ...idleStatus.json,
      submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: v }] },
    },
  });
  await withServer(
    { fetchStatus: pending("1.5.3"), upload: uploadOk, publish: publishOk },
    async ({ apiBase, requests }) => {
      const result = await uploadRelease(options(pkg, apiBase, { mode: "publish" }));
      assert.deepEqual(result, {
        outcome: "existing-submission",
        version: "1.5.3",
        state: "PENDING_REVIEW",
      });
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus"]
      );
    }
  );
  await withServer(
    { fetchStatus: pending("1.5.2.1", "STAGED"), upload: uploadOk },
    async ({ apiBase, requests }) => {
      await assert.rejects(uploadRelease(options(pkg, apiBase)), /STAGED/);
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus"]
      );
    }
  );
});

test("a rejected earlier submission does not block a new upload", async () => {
  const pkg = await makePackage("1.5.3");
  const status = {
    json: {
      ...idleStatus.json,
      submittedItemRevisionStatus: {
        state: "REJECTED",
        distributionChannels: [{ crxVersion: "1.5.2.1" }],
      },
    },
  };
  await withServer({ fetchStatus: status, upload: uploadOk }, async ({ apiBase }) => {
    const result = await uploadRelease(options(pkg, apiBase));
    assert.equal(result.outcome, "uploaded");
  });
});

test("errors never leak the access token", async () => {
  const pkg = await makePackage("1.5.3");
  const echo = { status: 403, json: { error: { message: `bad credential ${TOKEN}` } } };
  await withServer({ fetchStatus: echo }, async ({ apiBase }) => {
    await assert.rejects(uploadRelease(options(pkg, apiBase)), (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });
});

test("write requests are not retried on server errors", async () => {
  const pkg = await makePackage("1.5.3");
  await withServer(
    { fetchStatus: idleStatus, upload: { status: 503, json: {} }, publish: publishOk },
    async ({ apiBase, requests }) => {
      await assert.rejects(uploadRelease(options(pkg, apiBase, { mode: "publish" })), /HTTP 503/);
      assert.deepEqual(
        requests.map((r) => r.op),
        ["fetchStatus", "upload"]
      );
    }
  );
});
