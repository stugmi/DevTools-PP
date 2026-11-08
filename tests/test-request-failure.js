// Behavioral tests for failed/blocked request classification (request-capture.js).
// Run with `bun test tests/test-request-failure.js`. Loads the real source into a vm context.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "capture", "request-capture.js"),
  "utf8"
);
const { requestFailureFromHAR, requestStatusView, requestIsBlocked } = vm.runInContext(
  `${source}\n({ requestFailureFromHAR, requestStatusView, requestIsBlocked });`,
  vm.createContext({})
);

// Same path the capture uses: HAR entry -> record.response -> table view.
const view = (entry) => {
  const failure = requestFailureFromHAR(entry);
  return requestStatusView({
    response: { status: entry.response?.status ?? null, ...(failure ? { failure } : {}) },
  });
};

test("blocked by client is blocked and failed, with its reason", () => {
  const v = view({ response: { status: 0, _error: "net::ERR_BLOCKED_BY_CLIENT" } });
  assert.deepEqual(
    { text: v.text, kind: v.kind, failed: v.failed, title: v.title },
    { text: "(blocked)", kind: "blocked", failed: true, title: "net::ERR_BLOCKED_BY_CLIENT" }
  );
});

test("generic failure is never called blocked", () => {
  for (const error of ["net::ERR_ABORTED", "net::ERR_CONNECTION_REFUSED", "Failed"]) {
    const v = view({ response: { status: 0, _error: error } });
    assert.equal(v.kind, "failed", error);
    assert.equal(v.text, "(failed)", error);
    assert.equal(v.failed, true, error);
  }
});

test("explicit failure with an HTTP status is still a failure", () => {
  const v = view({ response: { status: 200, _error: "net::ERR_CONTENT_LENGTH_MISMATCH" } });
  assert.equal(v.failed, true);
  assert.equal(v.text, "200 (failed)");
});

test("HTTP errors are errors but not transport failures", () => {
  for (const status of [404, 500]) {
    const v = view({ response: { status, _error: null } });
    assert.equal(v.kind, "error");
    assert.equal(v.failed, false);
    assert.equal(v.text, String(status));
  }
});

test("success, redirect and socket upgrade are not failures", () => {
  assert.equal(view({ response: { status: 200, _error: null } }).kind, "ok");
  assert.equal(view({ response: { status: 302 } }).kind, "redirect");
  assert.equal(view({ response: { status: 101 } }).kind, "ok");
});

test("missing or zero status without an error stays pending, not failed", () => {
  for (const entry of [
    {},
    { response: { status: 0, _error: null } },
    { response: { status: -1 } },
  ]) {
    const v = view(entry);
    assert.equal(v.kind, "pending");
    assert.equal(v.failed, false);
  }
});

test("blank or non-string errors are ignored", () => {
  assert.equal(requestFailureFromHAR({ response: { _error: "  " } }), null);
  assert.equal(requestFailureFromHAR({ response: { _error: { text: "x" } } }), null);
});

test("failure snapshot is plain data independent of the live entry", () => {
  const entry = { response: { status: 0, _error: "net::ERR_BLOCKED_BY_RESPONSE" } };
  const failure = requestFailureFromHAR(entry);
  entry.response = null; // the live request is released
  assert.deepEqual({ ...failure }, { error: "net::ERR_BLOCKED_BY_RESPONSE", blocked: true });
});

// What the "Hide blocked" filter removes, built the way the capture builds a record.
const requestEntry = (harEntry) => {
  const failure = requestFailureFromHAR(harEntry);
  return {
    _record: {
      response: { status: harEntry.response?.status ?? null, ...(failure ? { failure } : {}) },
    },
  };
};

test("Hide blocked matches requests cancelled by the client or a response policy only", () => {
  for (const error of ["net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_RESPONSE"]) {
    assert.equal(requestIsBlocked(requestEntry({ response: { status: 0, _error: error } })), true);
  }
  for (const error of ["net::ERR_ABORTED", "net::ERR_CONNECTION_REFUSED", "net::ERR_FAILED"]) {
    assert.equal(requestIsBlocked(requestEntry({ response: { status: 0, _error: error } })), false);
  }
});

test("Hide blocked keeps successful, HTTP error and pending requests", () => {
  for (const harEntry of [
    { response: { status: 200 } },
    { response: { status: 403 } },
    { response: { status: 500, _error: null } },
    { response: { status: 0 } },
  ]) {
    assert.equal(requestIsBlocked(requestEntry(harEntry)), false, JSON.stringify(harEntry));
  }
});
