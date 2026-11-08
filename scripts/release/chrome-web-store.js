"use strict";

// Chrome Web Store API v2 client: verify signed CRX, upload it, optionally submit it.
// Docs: https://developer.chrome.com/docs/webstore/api
const fs = require("fs");
const { verifyCrx, readZipManifest } = require("./crx");

const API_BASE = "https://chromewebstore.googleapis.com";
const CRX_FILE_NAME = "devtools-plus-plus.crx";
const ACTIVE_STATES = new Set(["PENDING_REVIEW", "STAGED"]);
const PUBLISHED_STATES = new Set(["PUBLISHED", "PUBLISHED_TO_TESTERS"]);
const IN_PROGRESS = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);
const MAX_ERROR_BODY = 500;

function parseVersion(version, label) {
  if (typeof version !== "string" || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error(
      `${label} is not a numeric version of up to 4 components: ${JSON.stringify(version)}`
    );
  }
  return version.split(".").map(Number);
}

function compareVersions(a, b) {
  const left = parseVersion(a, "version");
  const right = parseVersion(b, "version");
  for (let i = 0; i < 4; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function highestVersion(revision) {
  let best = null;
  for (const channel of (revision && revision.distributionChannels) || []) {
    if (!channel || channel.crxVersion == null) continue;
    if (best === null || compareVersions(channel.crxVersion, best) > 0) best = channel.crxVersion;
  }
  return best;
}

async function manifestVersion(zipBytes) {
  const manifest = await readZipManifest(zipBytes);
  if (!manifest || typeof manifest.version !== "string")
    throw new Error("CRX manifest has no version");
  return manifest.version;
}

function redactor(secrets) {
  const list = secrets.filter(Boolean);
  return (text) => list.reduce((out, secret) => out.split(secret).join("[redacted]"), String(text));
}

function createClient({ apiBase, accessToken, publisherId, itemId, timeoutMs, redact }) {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const auth = { Authorization: `Bearer ${accessToken}` };

  async function request(label, url, init) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(
        redact(`${label} request failed: ${error && error.message ? error.message : error}`)
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        redact(`${label} failed with HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY)}`)
      );
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${label} returned a non-JSON response`);
    }
  }

  return {
    fetchStatus: () =>
      request("fetchStatus", `${apiBase}/v2/${name}:fetchStatus`, { method: "GET", headers: auth }),
    upload: (body) =>
      request("upload", `${apiBase}/upload/v2/${name}:upload`, {
        method: "POST",
        headers: {
          ...auth,
          "X-Goog-Upload-Protocol": "raw",
          "X-Goog-Upload-File-Name": CRX_FILE_NAME,
          "Content-Type": "application/octet-stream",
        },
        body,
      }),
    publish: () =>
      request("publish", `${apiBase}/v2/${name}:publish`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          publishType: "DEFAULT_PUBLISH",
          skipReview: false,
          blockOnWarnings: true,
        }),
      }),
  };
}

async function waitForAsyncUpload(client, { pollIntervalMs, pollTimeoutMs, sleep, now, log }) {
  const deadline = now() + pollTimeoutMs;
  for (;;) {
    await sleep(pollIntervalMs);
    const status = await client.fetchStatus();
    const state = status.lastAsyncUploadState;
    log(`async upload state: ${state || "unset"}`);
    if (state === "SUCCEEDED") return;
    if (state === "FAILED") throw new Error("Chrome Web Store reported the async upload FAILED");
    if (now() >= deadline) {
      throw new Error(
        `async upload did not finish within ${pollTimeoutMs} ms (last state: ${state || "unset"})`
      );
    }
    // IN_PROGRESS, NOT_FOUND (not visible yet) and unset: keep polling until the deadline.
  }
}

// Returns { outcome, version, state }. Never retries a write request.
async function uploadRelease(options) {
  const {
    file,
    version,
    expectedKeySha256,
    publisherId,
    itemId,
    accessToken,
    mode,
    apiBase = API_BASE,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    pollIntervalMs = 5000,
    pollTimeoutMs = 5 * 60 * 1000,
    requestTimeoutMs = 120000,
    log = (line) => console.log(line),
  } = options;
  const publish = options.publish !== undefined ? Boolean(options.publish) : mode === "publish";
  if (mode !== undefined && mode !== "upload" && mode !== "publish") {
    throw new Error(`mode must be "upload" or "publish", got ${JSON.stringify(mode)}`);
  }
  for (const [key, value] of Object.entries({
    file,
    version,
    expectedKeySha256,
    publisherId,
    itemId,
    accessToken,
  })) {
    if (!value) throw new Error(`${key} is required`);
  }
  parseVersion(version, "requested version");

  // Local validation first: nothing touches the network until the CRX is proven good.
  const bytes = fs.readFileSync(file);
  const { zip, signingKeySha256 } = verifyCrx(bytes, expectedKeySha256);
  const payloadVersion = await manifestVersion(zip);
  if (payloadVersion !== version) {
    throw new Error(
      `CRX manifest version ${payloadVersion} does not match requested version ${version}`
    );
  }
  log(`verified CRX ${version} signed by key ${signingKeySha256}`);

  const redact = redactor([accessToken]);
  const client = createClient({
    apiBase,
    accessToken,
    publisherId,
    itemId,
    timeoutMs: requestTimeoutMs,
    redact,
  });

  // Preflight: never replace an active submission, never go backwards.
  const status = await client.fetchStatus();
  if (status.takenDown)
    throw new Error("item has been taken down; resolve it in the developer dashboard");
  const published = status.publishedItemRevisionStatus;
  const publishedVersion = highestVersion(published);
  if (publishedVersion !== null) {
    const order = compareVersions(version, publishedVersion);
    if (order === 0 && published && PUBLISHED_STATES.has(published.state)) {
      log(`version ${version} is already published (${published.state}); nothing to do`);
      return { outcome: "already-published", version, state: published.state };
    }
    if (order < 0)
      throw new Error(`refusing downgrade: ${version} is older than published ${publishedVersion}`);
  }
  const submitted = status.submittedItemRevisionStatus;
  if (submitted && ACTIVE_STATES.has(submitted.state)) {
    const submittedVersion = highestVersion(submitted);
    if (submittedVersion !== null && compareVersions(submittedVersion, version) === 0) {
      log(`version ${version} already has a ${submitted.state} submission; not uploading again`);
      return { outcome: "existing-submission", version, state: submitted.state };
    }
    throw new Error(
      `a different submission (${submittedVersion || "unknown version"}) is ${submitted.state}; ` +
        "resolve it in the developer dashboard before uploading " +
        version
    );
  }
  if (IN_PROGRESS.has(status.lastAsyncUploadState)) {
    throw new Error("another async upload is still in progress for this item");
  }

  const uploaded = await client.upload(bytes);
  log(`upload state: ${uploaded.uploadState}`);
  if (IN_PROGRESS.has(uploaded.uploadState)) {
    await waitForAsyncUpload(client, { pollIntervalMs, pollTimeoutMs, sleep, now, log });
  } else if (uploaded.uploadState !== "SUCCEEDED") {
    throw new Error(`upload did not succeed (state: ${uploaded.uploadState || "unset"})`);
  } else if (uploaded.crxVersion !== undefined && uploaded.crxVersion !== version) {
    throw new Error(`store reports uploaded version ${uploaded.crxVersion}, expected ${version}`);
  }

  if (!publish) {
    log(`version ${version} uploaded as a draft; not submitted (upload mode)`);
    return { outcome: "uploaded", version, state: "DRAFT" };
  }

  const result = await client.publish();
  const warnings = (result.warningInfo && result.warningInfo.warnings) || [];
  for (const warning of warnings)
    log(`publish warning: ${warning.reason || ""} ${warning.description || ""}`.trim());
  if (result.state === "PUBLISHED" || result.state === "PUBLISHED_TO_TESTERS") {
    log(`version ${version} is ${result.state}`);
  } else {
    log(`version ${version} submitted; state ${result.state} (not yet publicly published)`);
  }
  return { outcome: "submitted", version, state: result.state };
}

function parseArgs(argv) {
  const args = { mode: "upload" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--file" || flag === "--version" || flag === "--mode") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      args[flag.slice(2)] = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.file) throw new Error("--file is required");
  if (!args.version) throw new Error("--version is required");
  if (args.mode !== "upload" && args.mode !== "publish")
    throw new Error("--mode must be upload or publish");
  return args;
}

async function main(argv, env) {
  const args = parseArgs(argv);
  const required = {
    accessToken: "CWS_ACCESS_TOKEN",
    publisherId: "CWS_PUBLISHER_ID",
    itemId: "CWS_EXTENSION_ID",
    expectedKeySha256: "CWS_SIGNING_KEY_SHA256",
  };
  const config = {};
  for (const [key, name] of Object.entries(required)) {
    if (!env[name]) throw new Error(`${name} is required`);
    config[key] = env[name];
  }
  return uploadRelease({ ...config, file: args.file, version: args.version, mode: args.mode });
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((error) => {
    console.error(`chrome-web-store: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { uploadRelease, compareVersions };
