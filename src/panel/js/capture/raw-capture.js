// Raw resources: maps page resources (scripts, styles, documents...) into state.rawTree.
// Loaded after discovery.js and before request-capture.js and capture.js.
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

// Response MIME types of API calls. No `xml`: it would catch SVG images and static
// sitemap/feed files.
const API_CONTENT_TYPE_RE =
  /^(?:application\/(?:[\w.+-]*\+)?json|application\/graphql|text\/event-stream)$/;

// API calls belong in the Network section, not in the raw file tree.
function isApiResource(resource) {
  const method = (resource.method || resource.request?.method || "").toUpperCase();
  if (method && method !== "GET" && method !== "HEAD") return true;
  const type = (resource.type || resource._resourceType || "").toLowerCase();
  if (API_RESOURCE_TYPES.has(type)) return true;
  // A known type (script, image, manifest...) wins over the response MIME.
  if (type && type !== "other") return false;
  const contentType =
    resource.contentType ||
    state.contentTypesByURL.get(resource.url || resource.request?.url) ||
    "";
  return API_CONTENT_TYPE_RE.test(contentType.split(";")[0].trim().toLowerCase());
}

function rawResourcePath(url, type) {
  if (!url) return null;
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  if (isBlacklistedResourceURL(url)) return null;
  try {
    const u = new URL(url);
    // `host` keeps the port, so localhost:3000 and localhost:8080 stay apart.
    const host = u.host || "(no-host)";
    let path = u.pathname.replace(/^\/+/, "");
    if (!path || path.endsWith("/")) {
      const ext = TYPE_DEFAULT_EXT[type] || "";
      path += ext ? "index." + ext : "index";
    } else {
      // Filename has no extension: guess one from the resource type.
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

// Returns true when the raw tree changed (a rebuild is needed). An entry captured before the
// last navigation (older scanGeneration) gets its content dropped so it is loaded again,
// unless the user edited it.
function addRawResource(r) {
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
      if (existing._generation === state.scanGeneration) return false;
      existing._generation = state.scanGeneration;
      if (existing.edited) return false;
      existing.content = null;
      existing.fetchStatus = null;
      state.rawCache.delete(r.url);
      return true;
    }
  }

  const base = rawResourcePath(r.url, r.type);
  if (!base) return false;
  const tree = state.rawTree;
  let path = base;
  let i = 1;
  while (tree[path]) {
    i++;
    path = insertSuffixBeforeExt(base, String(i));
  }
  tree[path] = {
    content: null,
    sourceURL: r.url,
    scriptURL: r.url,
    mapURL: null,
    type: r.type,
    contentType: state.contentTypesByURL.get(r.url) || null,
    _resource: r,
    _generation: state.scanGeneration,
  };
  state.rawByURL.set(r.url, { path, section: "raw" });
  return true;
}

function syncRawTree(resources) {
  for (const r of resources) addRawResource(r);
}
