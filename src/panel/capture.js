"use strict";

const TYPE_DEFAULT_EXT = {
  document: "html",
  stylesheet: "css",
  script: "js",
  image: "png",
  font: "woff",
  manifest: "json",
  xhr: "json",
  fetch: "json",
};

const API_RESOURCE_TYPES = new Set(["xhr", "fetch", "eventsource", "websocket"]);

function isApiResource(resource) {
  const method = (resource.method || resource.request?.method || "").toUpperCase();
  if (method && method !== "GET" && method !== "HEAD") return true;
  if (API_RESOURCE_TYPES.has((resource.type || resource._resourceType || "").toLowerCase())) {
    return true;
  }
  const contentType =
    resource.contentType ||
    state.contentTypesByURL.get(resource.url || resource.request?.url) ||
    "";
  return /(?:json|graphql|xml|event-stream)/i.test(contentType);
}

function rawResourcePath(url, type) {
  if (!url) return null;
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  if (url.startsWith("chrome-extension://") || url.startsWith("devtools://")) return null;
  try {
    const u = new URL(url);
    const host = u.hostname || "(no-host)";
    let path = u.pathname.replace(/^\/+/, "");
    if (!path || path.endsWith("/")) {
      const ext = TYPE_DEFAULT_EXT[type] || "";
      path += ext ? "index." + ext : "index";
    } else {
      // Filename has no extension — synthesize one from resource type.
      const last = path.split("/").pop();
      if (last && !last.includes(".")) {
        const ext = TYPE_DEFAULT_EXT[type];
        if (ext) path += "." + ext;
      }
    }
    return host + "/" + path;
  } catch {
    return null;
  }
}

function contentTypeFromHAR(entry) {
  const response = entry && entry.response;
  if (!response) return null;
  const header = (response.headers || []).find((h) => h.name.toLowerCase() === "content-type");
  return (header && header.value) || response.content?.mimeType || null;
}

function requestContentTypeFromHAR(entry) {
  const request = entry && entry.request;
  if (!request) return null;
  const header = (request.headers || []).find((h) => h.name.toLowerCase() === "content-type");
  return (header && header.value) || request.postData?.mimeType || null;
}

function updateContentTypesFromHAR(har) {
  if (!har || !har.entries) return;
  for (const entry of har.entries) {
    const url = entry.request && entry.request.url;
    const contentType = contentTypeFromHAR(entry);
    if (url && contentType) state.contentTypesByURL.set(url, contentType);
  }
}

function removeRawResource(url) {
  const location = state.rawByURL.get(url);
  if (!location) return null;
  delete state.rawTree[location.path];
  state.rawByURL.delete(url);
  return location;
}

function addRawResource(r, refreshExisting = false) {
  if (!r || !r.url) return false;
  if (isApiResource(r)) return Boolean(removeRawResource(r.url));

  const existingLocation = state.rawByURL.get(r.url);
  if (existingLocation) {
    const existing = state.rawTree[existingLocation.path];
    if (!existing) {
      state.rawByURL.delete(r.url);
    } else {
      existing.type = r.type || existing.type;
      existing.contentType =
        r.contentType || state.contentTypesByURL.get(r.url) || existing.contentType;
      existing._resource = r;
      if (refreshExisting) {
        existing.content = null;
        existing.fetchStatus = null;
        state.rawCache.delete(r.url);
      }
      return refreshExisting;
    }
  }

  const base = rawResourcePath(r.url, r.type);
  if (!base) return false;
  const tree = state.rawTree;
  let path = base;
  let i = 1;
  while (tree[path]) {
    i++;
    path = base + "." + i;
  }
  tree[path] = {
    content: null,
    sourceURL: r.url,
    scriptURL: r.url,
    mapURL: null,
    type: r.type,
    contentType: state.contentTypesByURL.get(r.url) || null,
    _resource: r,
  };
  state.rawByURL.set(r.url, { path, section: "raw" });
  return true;
}

function syncRawTree(resources, preserveExisting) {
  if (!preserveExisting) {
    state.rawTree = {};
    state.requestTree = {};
    state.rawByURL = new Map();
    state.requestPathCounts = new Map();
    state.capturedRequestKeys = new Set();
    state.requestOccurrences = new Map();
  }
  for (const r of resources) addRawResource(r, preserveExisting);
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
  const body = {};
  for (const param of params || []) {
    const value =
      param.fileName || param.contentType
        ? {
            value: param.value ?? null,
            fileName: param.fileName || null,
            contentType: param.contentType || null,
          }
        : (param.value ?? "");
    if (!(param.name in body)) {
      body[param.name] = value;
    } else if (Array.isArray(body[param.name])) {
      body[param.name].push(value);
    } else {
      body[param.name] = [body[param.name], value];
    }
  }
  return body;
}

function structuredBody(text, mimeType, params, encoding) {
  if (encoding === "base64" && text != null) {
    return { encoding: "base64", data: text };
  }
  if (text != null) {
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (mime === "application/json" || mime.endsWith("+json")) {
      try {
        return JSON.parse(text);
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

function getFinishedRequestContent(entry) {
  const fallback = {
    content: entry.response?.content?.text ?? null,
    encoding: entry.response?.content?.encoding ?? null,
  };
  if (typeof entry.getContent !== "function") return Promise.resolve(fallback);
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

function requestFingerprint(entry) {
  const request = entry?.request;
  return [
    entry?.startedDateTime || "",
    request?.method || "",
    request?.url || "",
    request?.postData?.text || "",
    entry?.time ?? "",
    entry?.response?.status ?? "",
  ].join("\0");
}

function nextFinishedRequestKey(entry) {
  const fingerprint = requestFingerprint(entry);
  const occurrence = (state.requestOccurrences.get(fingerprint) || 0) + 1;
  state.requestOccurrences.set(fingerprint, occurrence);
  return `${fingerprint}\0${occurrence}`;
}

function captureRequestsFromHAR(entries, deferRebuild) {
  const occurrences = new Map();
  for (const entry of entries || []) {
    const fingerprint = requestFingerprint(entry);
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    captureRequestSnapshot(entry, deferRebuild, `${fingerprint}\0${occurrence}`);
  }
}

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

function serializeRequestEntry(entry) {
  entry.content = JSON.stringify(entry._record, null, 2) + "\n";
}

function setRequestResponseBody(entry, text, encoding) {
  entry._rawResponseBody = text;
  const body = structuredBody(text, entry._record.response.bodyMimeType, null, encoding);
  if (body === undefined) {
    delete entry._record.response.body;
  } else {
    entry._record.response.body = body;
  }
  if (encoding) entry._record.response.bodyEncoding = encoding;
  serializeRequestEntry(entry);
}

async function loadRequestResponse(entry) {
  if (!entry || entry._responseStatus === "loaded" || entry._responseStatus === "unavailable") {
    return;
  }
  if (!canLoadResponseBody(entry)) {
    entry._responseStatus = "unavailable";
    return;
  }
  if (entry._responseStatus === "loading") return entry._responsePromise;

  entry._responseStatus = "loading";
  entry._responsePromise = getFinishedRequestContent(entry._request).then(
    ({ content, encoding }) => {
      if (content == null) {
        entry._responseStatus = "unavailable";
        return;
      }
      setRequestResponseBody(entry, content, encoding);
      entry._responseStatus = "loaded";
    }
  );
  await entry._responsePromise;
}

function captureRequestSnapshot(entry, deferRebuild = false, requestKey = null) {
  if (!panelVisible) return false;
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
  const responseBody = structuredBody(responseText, responseContentType, null, responseEncoding);
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
      ...(responseBody === undefined ? {} : { body: responseBody }),
    },
    timings: entry.timings || null,
  };

  const wasSelected = isApiResource(entry) ? migrateRawTabToRequest(url, path) : false;
  const requestEntry = {
    content: "",
    sourceURL: url,
    scriptURL: url,
    mapURL: null,
    type: "request",
    contentType: "application/json",
    fetchStatus: "ok",
    _captureSequence: sequence,
    _request: entry,
    _requestType: entry._resourceType || null,
    _record: record,
    _rawRequestBody: request.postData?.text ?? null,
    _rawResponseBody: responseText,
    _responseStatus: responseText == null ? "idle" : "loaded",
    _responsePromise: null,
  };
  if (!canLoadResponseBody(requestEntry) && responseText == null) {
    requestEntry._responseStatus = "unavailable";
  }
  serializeRequestEntry(requestEntry);
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

async function processScript(resource, resourceMap) {
  if (!resource || !resource.url) return 0;
  if (isBlacklistedResourceURL(resource.url)) return 0;
  if (state.scannedScripts.has(resource.url)) return 0;
  state.scannedScripts.add(resource.url);

  const content = decodeResource(await getResourceContent(resource));
  if (!content) return 0;

  const smURL = extractSourceMapURL(content);
  if (!smURL) return 0;

  const resolved = resolveURL(resource.url, smURL);
  const map = await loadMap(resolved, resourceMap);
  if (!map) return 0;

  return addMapToTree(map, resource.url, resolved);
}

async function scanAll({ preserveExisting = state.collectAcrossNavigations } = {}) {
  if (!panelVisible || state.scanning) return;
  state.scanning = true;
  setStatus(
    "connecting",
    state.collectAcrossNavigations ? "Collecting sources and requests…" : "Scanning sources…"
  );
  try {
    const har = await getHAR();
    if (!panelVisible) return;
    updateContentTypesFromHAR(har);
    const resources = await getResources();
    if (!panelVisible) return;
    const resourceMap = new Map(resources.map((r) => [r.url, r]));
    const scripts = resources.filter((r) => r.type === "script");

    syncRawTree(resources, preserveExisting);
    captureRequestsFromHAR(har?.entries, true);

    for (const s of scripts) {
      if (!panelVisible) return;
      await processScript(s, resourceMap);
    }
    if (panelVisible) rebuild();
  } finally {
    state.scanning = false;
  }
}

function rebuild() {
  // Authored files are grouped under the domain their source map was served from.
  state.treeModel = buildTreeModel(filteredTreeFor("mapped"), { groupByDomain: true });
  state.rawTreeModel = buildTreeModel(filteredTreeFor("raw"));
  state.requestTreeModel = buildTreeModel(filteredTreeFor("requests"));

  const mappedCount = getItemsInSection("mapped").length;
  const rawCount = getItemsInSection("raw").length;
  const requestCount = getItemsInSection("requests").length;
  const visibleFileCount = (state.showMapped ? mappedCount : 0) + (state.showRaw ? rawCount : 0);
  const filesCapturedCount =
    Object.keys(state.sourceTree).length + Object.keys(state.rawTree).length;
  const totalCapturedCount = filesCapturedCount + Object.keys(state.requestTree).length;

  el.fileCount.textContent = filesCapturedCount ? String(visibleFileCount) : "—";

  if (totalCapturedCount === 0) {
    setStatus(
      "active",
      `${state.collectAcrossNavigations ? "Collecting" : "Watching"} — nothing to show`
    );
    el.btnExportAll.disabled = true;
  } else {
    const parts = [];
    if (state.showMapped) parts.push(`${mappedCount} mapped`);
    if (state.showRaw) parts.push(`${rawCount} raw`);
    parts.push(`${requestCount} requests`);
    setStatus(
      "active",
      `${state.collectAcrossNavigations ? "Collecting across navigations" : "Watching"} — ${parts.join(", ")}`
    );
    el.btnExportAll.disabled = false;
  }
  renderTree();
  SourceEditor.scheduleProjectSync();
}

function resetCapture() {
  state.sourceTree = {};
  state.rawTree = {};
  state.requestTree = {};
  state.rawByURL = new Map();
  state.requestPathCounts = new Map();
  state.capturedRequestKeys = new Set();
  state.requestOccurrences = new Map();
  state.requestCaptureSequence = 0;
  state.contentTypesByURL = new Map();
  state.scannedScripts.clear();
  state.rawCache = new Map();
  state.treeModel = null;
  state.rawTreeModel = null;
  state.requestTreeModel = null;
  state.selectedPath = null;
  state.selectedSection = null;
  state.tabs = [];
  state.activeTabId = null;
  openDirs.clear();
  userToggledDirs.clear();
  el.fileCount.textContent = "—";
  el.btnExportAll.disabled = true;
  el.emptyState.style.display = "flex";
  el.treeRoot.style.display = "none";
  resetPreview();
  renderTabs();
  renderNetworkTable();
}

// Live updates. Resource events only update lightweight metadata immediately.
// Script body inspection is debounced until the page has gone quiet so this
// panel never competes with an in-flight navigation for DevTools resources.
let scriptScanTimer = null;
let rebuildTimer = null;

function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (panelVisible) rebuild();
  }, 100);
}

function scheduleScriptScan(delay = 1000) {
  clearTimeout(scriptScanTimer);
  scriptScanTimer = setTimeout(() => {
    scriptScanTimer = null;
    if (!panelVisible) return;
    if (state.scanning) {
      scheduleScriptScan(250);
      return;
    }
    scanAll({ preserveExisting: true });
  }, delay);
}

insp.onResourceAdded.addListener((resource) => {
  if (!resource || !panelVisible) return;
  if (addRawResource(resource, state.collectAcrossNavigations)) scheduleRebuild();
  if (resource.type === "script") scheduleScriptScan();
});

network.onNavigated.addListener(() => {
  if (!panelVisible) return;
  state.scannedScripts.clear();
  state.rawCache = new Map();
  if (!state.collectAcrossNavigations) resetCapture();
  scheduleScriptScan();
});

network.onRequestFinished.addListener((request) => {
  if (!panelVisible) return;
  const url = request.request && request.request.url;
  const contentType = contentTypeFromHAR(request);
  if (!url || isBlacklistedResourceURL(url)) return;
  if (contentType) state.contentTypesByURL.set(url, contentType);
  try {
    if (captureRequestSnapshot(request, true)) scheduleRebuild();
  } catch (error) {
    setStatus("inactive", `Request capture failed: ${error.message}`);
  }
});

// The panel page can exist while another DevTools tab is focused. Stay fully
// passive until DevTools explicitly reports that Source Exporter is visible.
window.addEventListener("message", (event) => {
  if (event.data?.type === "PANEL_SHOWN") {
    const wasHidden = !panelVisible;
    panelVisible = true;
    if (wasHidden) {
      state.scannedScripts.clear();
      state.rawCache = new Map();
      if (!state.collectAcrossNavigations) resetCapture();
      scheduleScriptScan(500);
    }
  }
  if (event.data?.type === "PANEL_HIDDEN") {
    panelVisible = false;
    clearTimeout(scriptScanTimer);
    scriptScanTimer = null;
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    closeQuickPicker();
  }
});
