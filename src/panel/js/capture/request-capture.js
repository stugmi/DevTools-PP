// Network requests: turns HAR entries and finished requests into state.requestTree records.
// Loaded after raw-capture.js (uses isApiResource, contentTypeFromHAR, removeRawResource) and
// before capture.js.
"use strict";

function requestContentTypeFromHAR(entry) {
  const request = entry && entry.request;
  if (!request) return null;
  const header = (request.headers || []).find((h) => h.name.toLowerCase() === "content-type");
  return (header && header.value) || request.postData?.mimeType || null;
}

function headersFromHAR(headers) {
  return (headers || []).map(({ name, value }) => ({ name, value }));
}

function cookiesFromHAR(cookies) {
  return (cookies || []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "",
    domain: cookie.domain || "",
    expires: cookie.expires || "",
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: cookie.sameSite || "",
  }));
}

function paramsToObject(params) {
  const body = Object.create(null);
  for (const param of params || []) {
    const value =
      param.fileName || param.contentType
        ? {
            value: param.value ?? null,
            fileName: param.fileName || null,
            contentType: param.contentType || null,
          }
        : (param.value ?? "");
    if (!Object.hasOwn(body, param.name)) {
      body[param.name] = value;
    } else if (Array.isArray(body[param.name])) {
      body[param.name].push(value);
    } else {
      body[param.name] = [body[param.name], value];
    }
  }
  return body;
}

// -- Exact JSON --
// Integers beyond 2^53 are kept as BigInt (via the source text) so the Parsed view and the
// exported record show every digit. Callers that walk parsed bodies must tolerate BigInt.
function parseJsonExact(text) {
  return JSON.parse(text, (key, value, context) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    /^-?\d+$/.test(context?.source ?? "")
      ? BigInt(context.source)
      : value
  );
}

// JSON.stringify throws on BigInt; emit it as a raw number instead.
function stringifyJsonExact(value, space) {
  return JSON.stringify(
    value,
    (key, item) => (typeof item === "bigint" ? JSON.rawJSON(item.toString()) : item),
    space
  );
}

function structuredBody(text, mimeType, params, encoding) {
  if (encoding === "base64" && text != null) {
    return { encoding: "base64", data: text };
  }
  if (text != null) {
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (mime === "application/json" || mime.endsWith("+json")) {
      try {
        return parseJsonExact(text);
      } catch {
        return text;
      }
    }
    if (mime === "application/x-www-form-urlencoded") {
      return paramsToObject(
        Array.from(new URLSearchParams(text), ([name, value]) => ({ name, value }))
      );
    }
    return text;
  }
  if (params?.length) return paramsToObject(params);
  return undefined;
}

// Resolves `{content, encoding, reason}`; `reason` explains a missing body when known.
function getFinishedRequestContent(entry) {
  const fallback = {
    content: entry?.response?.content?.text ?? null,
    encoding: entry?.response?.content?.encoding ?? null,
    reason: null,
  };
  if (typeof entry?.getContent !== "function") {
    if (fallback.content == null) {
      fallback.reason = "Body not available for requests captured from a HAR snapshot.";
    }
    return Promise.resolve(fallback);
  }
  const pending = new Promise((resolve) => {
    try {
      entry.getContent((content, encoding) => resolve({ content, encoding }));
    } catch {
      resolve(fallback);
    }
  });
  return withTimeout(pending, NETWORK_CALL_TIMEOUT_MS, fallback);
}

function requestPathFor(url, type) {
  const base = rawResourcePath(url, type) || "requests/request";
  const candidate = `${base}.request.json`;
  let ordinal = (state.requestPathCounts.get(candidate) || 0) + 1;
  let path = ordinal === 1 ? candidate : insertSuffixBeforeExt(candidate, String(ordinal));
  while (state.requestTree[path]) {
    ordinal++;
    path = insertSuffixBeforeExt(candidate, String(ordinal));
  }
  state.requestPathCounts.set(candidate, ordinal);
  return path;
}

// Identical requests (same fingerprint) are told apart by an occurrence counter, so the same
// request is never captured twice.
function requestFingerprint(entry) {
  const request = entry?.request;
  const postText = request?.postData?.text;
  return [
    entry?.startedDateTime || "",
    request?.method || "",
    request?.url || "",
    // Length plus a prefix, so a large POST body is not retained in every key.
    postText ? `${postText.length}:${postText.slice(0, 256)}` : "",
    entry?.time ?? "",
    entry?.response?.status ?? "",
  ].join("\0");
}

// Live requests count occurrences across the whole session.
function nextFinishedRequestKey(entry) {
  const fingerprint = requestFingerprint(entry);
  const occurrence = (state.requestOccurrences.get(fingerprint) || 0) + 1;
  state.requestOccurrences.set(fingerprint, occurrence);
  return `${fingerprint}\0${occurrence}`;
}

// A HAR snapshot recounts from zero on every scan, so rescans yield the same keys and
// already captured requests are skipped.
function captureRequestsFromHAR(entries, deferRebuild) {
  const occurrences = new Map();
  for (const entry of entries || []) {
    const fingerprint = requestFingerprint(entry);
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    captureRequestSnapshot(entry, deferRebuild, `${fingerprint}\0${occurrence}`);
  }
}

// A resource first seen as a raw file can turn out to be an API call. Move its open tab and
// selection to the request entry. Returns true if it was the selected file.
function migrateRawTabToRequest(url, requestPath) {
  const location = removeRawResource(url);
  if (!location) return false;
  const oldId = tabId(location.path, "raw");
  const newId = tabId(requestPath, "requests");
  for (const tab of state.tabs) {
    if (tab.id !== oldId) continue;
    tab.id = newId;
    tab.path = requestPath;
    tab.section = "requests";
    tab.dirty = false;
  }
  if (state.activeTabId === oldId) state.activeTabId = newId;
  const wasSelected = state.selectedSection === "raw" && state.selectedPath === location.path;
  if (wasSelected) {
    state.selectedSection = "requests";
    state.selectedPath = requestPath;
  }
  const filesSelection = state.listSelection.files;
  if (filesSelection?.section === "raw" && filesSelection.path === location.path) {
    state.listSelection.files = null;
    state.listSelection.network = requestPath;
  }
  return wasSelected;
}

function requestTypeFor(entry) {
  const record = entry?._record;
  const resourceType = (
    entry?._requestType ||
    record?.resourceType ||
    entry?._request?._resourceType ||
    ""
  ).toLowerCase();
  const mimeType = (
    record?.response?.bodyMimeType ||
    record?.request?.bodyMimeType ||
    entry?.contentType ||
    ""
  ).toLowerCase();
  const url = record?.request?.url || entry?.sourceURL || "";

  if (resourceType === "websocket" || resourceType === "eventsource") return "socket";
  if (
    resourceType === "wasm" ||
    mimeType.includes("application/wasm") ||
    /\.wasm(?:$|[?#])/i.test(url)
  ) {
    return "wasm";
  }
  if (resourceType === "document" || mimeType.includes("text/html")) return "doc";
  if (resourceType === "script" || /\.[cm]?js(?:$|[?#])/i.test(url)) return "js";
  const isXhrLike = resourceType === "xhr" || resourceType === "fetch";
  if (isXhrLike && (mimeType.includes("json") || mimeType.endsWith("+json"))) return "json";
  if (
    resourceType === "image" ||
    resourceType === "media" ||
    resourceType === "font" ||
    /^(image|video|audio|font)\//.test(mimeType)
  ) {
    return "media";
  }
  if (isXhrLike) return "xhr";
  return "other";
}

function canLoadResponseBody(entry) {
  const method = entry?._record?.request?.method?.toUpperCase();
  const status = entry?._record?.response?.status;
  const kind = requestTypeFor(entry);
  return kind !== "socket" && method !== "HEAD" && status !== 204 && status !== 304;
}

// `entry.content` (the record as JSON) is built on first read and cached. Call this after
// changing the record so the next read re-serializes.
function invalidateRequestContent(entry) {
  entry._content = null;
}

function setRequestResponseBody(entry, text, encoding) {
  entry._rawResponseBody = text;
  entry._responseBodyCache = null;
  if (encoding) entry._record.response.bodyEncoding = encoding;
  invalidateRequestContent(entry);
}

// `record.response.body` is derived from `_rawResponseBody` on first read, so the parsed copy
// only exists once something looks at it. It stays enumerable so the record serializes with it.
function attachLazyResponseBody(entry) {
  const response = entry._record.response;
  Object.defineProperty(response, "body", {
    enumerable: true,
    configurable: true,
    get() {
      const text = entry._rawResponseBody;
      if (text == null) return undefined;
      entry._responseBodyCache ??= {
        value: structuredBody(text, response.bodyMimeType, null, response.bodyEncoding ?? null),
      };
      return entry._responseBodyCache.value;
    },
  });
}

// Never rejects: failures leave the entry "unavailable" with `_responseError` set.
async function fetchRequestResponseBody(entry) {
  try {
    const { content, encoding, reason } = await getFinishedRequestContent(entry._request);
    if (content == null) {
      entry._responseStatus = "unavailable";
      entry._responseError = reason || null;
      return;
    }
    setRequestResponseBody(entry, content, encoding);
    entry._responseStatus = "loaded";
  } catch (error) {
    entry._responseStatus = "unavailable";
    entry._responseError = `Could not load response content: ${error?.message || error}`;
  }
}

// Fetches the response body on demand (at most once per entry) and rewrites the record.
// While loading, `entry._responsePromise` is set; it is cleared once the load settles.
function loadRequestResponse(entry) {
  if (!entry || entry._responseStatus === "loaded" || entry._responseStatus === "unavailable") {
    return Promise.resolve();
  }
  if (!canLoadResponseBody(entry)) {
    entry._responseStatus = "unavailable";
    return Promise.resolve();
  }
  if (entry._responseStatus === "loading") return entry._responsePromise;

  entry._responseStatus = "loading";
  entry._responseError = null;
  entry._responsePromise = fetchRequestResponseBody(entry).finally(() => {
    entry._responsePromise = null;
    // Only getContent needed the live request; the record has everything else.
    entry._request = null;
  });
  return entry._responsePromise;
}

// Returns true when a new request entry was added. `deferRebuild` leaves the UI refresh to
// the caller (used when capturing in bulk or when rebuilds are debounced).
function captureRequestSnapshot(entry, deferRebuild = false, requestKey = null) {
  if (!state.panelVisible) return false;
  const request = entry?.request;
  const url = request?.url;
  if (!url || isBlacklistedResourceURL(url)) return false;

  const captureKey = requestKey || nextFinishedRequestKey(entry);
  if (state.capturedRequestKeys.has(captureKey)) return false;
  const responseContentType = contentTypeFromHAR(entry);
  const requestContentType = requestContentTypeFromHAR(entry);
  const responseText = entry.response?.content?.text ?? null;
  const responseEncoding = entry.response?.content?.encoding ?? null;

  state.capturedRequestKeys.add(captureKey);
  const sequence = ++state.requestCaptureSequence;
  const path = requestPathFor(url, entry._resourceType || "fetch");
  if (responseContentType) state.contentTypesByURL.set(url, responseContentType);

  const requestBody = structuredBody(
    request.postData?.text,
    requestContentType,
    request.postData?.params,
    null
  );
  const record = {
    capturedAt: entry.startedDateTime || new Date().toISOString(),
    durationMs: entry.time ?? null,
    resourceType: entry._resourceType || null,
    request: {
      method: request.method || "GET",
      url,
      httpVersion: request.httpVersion || null,
      headers: headersFromHAR(request.headers),
      headersText: request.headersText || null,
      queryParams: headersFromHAR(request.queryString),
      cookies: cookiesFromHAR(request.cookies),
      bodySize: request.bodySize ?? null,
      bodyMimeType: requestContentType,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    },
    response: {
      status: entry.response?.status ?? null,
      statusText: entry.response?.statusText || "",
      httpVersion: entry.response?.httpVersion || null,
      headers: headersFromHAR(entry.response?.headers),
      cookies: cookiesFromHAR(entry.response?.cookies),
      headersText: entry.response?.headersText || null,
      redirectURL: entry.response?.redirectURL || null,
      remoteAddress: entry.serverIPAddress || null,
      bodySize: entry.response?.bodySize ?? null,
      contentSize: entry.response?.content?.size ?? null,
      bodyMimeType: responseContentType,
      ...(responseEncoding ? { bodyEncoding: responseEncoding } : {}),
    },
    timings: entry.timings || null,
  };

  const wasSelected = isApiResource(entry) ? migrateRawTabToRequest(url, path) : false;
  const requestEntry = {
    // The record as JSON, built on first read (see invalidateRequestContent).
    _content: null,
    get content() {
      this._content ??= stringifyJsonExact(this._record, 2) + "\n";
      return this._content;
    },
    set content(value) {
      this._content = value;
    },
    sourceURL: url,
    scriptURL: url,
    mapURL: null,
    type: "request",
    contentType: "application/json",
    fetchStatus: "ok",
    _captureSequence: sequence,
    // The live request is only kept while a body may still be fetched through getContent.
    _request: responseText == null ? entry : null,
    _requestType: entry._resourceType || null,
    _record: record,
    _rawRequestBody: request.postData?.text ?? null,
    _rawResponseBody: responseText,
    _responseBodyCache: null,
    _responseStatus: responseText == null ? "idle" : "loaded",
    _responseError: null,
    _responsePromise: null,
  };
  attachLazyResponseBody(requestEntry);
  if (!canLoadResponseBody(requestEntry) && responseText == null) {
    requestEntry._responseStatus = "unavailable";
  }
  state.requestTree[path] = requestEntry;

  const tab = state.tabs.find((item) => item.id === tabId(path, "requests"));
  if (tab) tab.dirty = false;

  if (!deferRebuild) {
    renderTabs();
    rebuild();
    if (wasSelected || (state.selectedSection === "requests" && state.selectedPath === path)) {
      selectFile(path, "requests");
    }
  }
  return true;
}
