// DevTools resource access: getResources/getHAR/getContent wrappers with timeouts, plus
// source map loading and mapped-file path normalization. No debugger attach.
// Loaded after state.js (uses insp, network, state) and before the other capture files.
"use strict";

// getContent() callbacks and fetch() calls can hang forever (evicted HAR body, streaming
// response, dead sourcemap host) and exhaust the browser's shared connection pool. Every
// network round trip in the capture files must go through one of the timeout helpers below.
const NETWORK_CALL_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(fallback));
  });
}

// Resolves to the body (text, or parsed JSON when `read` is "json"), or null for a non-OK
// status. The timeout also covers the body read, which can stall after the headers arrive.
// Throws on abort and network errors.
async function fetchWithTimeout(url, ms, read = "text") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await (read === "json" ? res.json() : res.text());
  } finally {
    clearTimeout(timer);
  }
}

// Extension and DevTools URLs (this panel, other extensions' content scripts) are never
// page content.
function isBlacklistedResourceURL(url) {
  return Boolean(url) && /^(?:chrome-extension|moz-extension|devtools):/i.test(url);
}

function getResources() {
  const pending = new Promise((resolve) =>
    insp.getResources((resources) => {
      resolve(resources.filter((resource) => !isBlacklistedResourceURL(resource?.url)));
    })
  );
  return withTimeout(pending, NETWORK_CALL_TIMEOUT_MS, []);
}

function getHAR() {
  const pending = new Promise((resolve) => network.getHAR(resolve));
  return withTimeout(pending, NETWORK_CALL_TIMEOUT_MS, null);
}

// Identity of the document loaded in the inspected tab. performance.timeOrigin changes on
// every load, same-URL reloads included, but not on SPA route changes. Null on failure.
function getInspectedPageId() {
  const pending = new Promise((resolve) =>
    insp.eval("performance.timeOrigin", (result, exception) => resolve(exception ? null : result))
  );
  return withTimeout(pending, NETWORK_CALL_TIMEOUT_MS, null);
}

function isFetchableURL(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function getResourceContent(resource) {
  const pending = new Promise((resolve) => {
    resource.getContent((content, encoding) => resolve({ content, encoding }));
  });
  return withTimeout(pending, NETWORK_CALL_TIMEOUT_MS, { content: null, encoding: null });
}

// atob() yields one char per byte (Latin-1); decode those bytes as UTF-8. Accepts base64url.
function base64ToText(b64) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function decodeResource({ content, encoding }) {
  if (content == null) return null;
  if (encoding === "base64") {
    try {
      return base64ToText(content);
    } catch {
      return null;
    }
  }
  return content;
}

// Cheap change detector for script bodies: length plus FNV-1a over the UTF-16 units.
function textSignature(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return text.length + ":" + (hash >>> 0).toString(36);
}

// URL from the last `//# sourceMappingURL=` (or `/*# ... */`) comment. Searches the whole
// text, since inline data: maps are often far larger than any fixed tail window.
function extractSourceMapURL(text) {
  const idx = text.lastIndexOf("sourceMappingURL=");
  if (idx < 0) return null;
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  if (!/(?:\/\/|\/\*)[#@]\s*$/.test(text.slice(lineStart, idx))) return null;
  return /^[^\s'"*]+/.exec(text.slice(idx + 17))?.[0] ?? null;
}

function resolveURL(base, rel) {
  if (rel.startsWith("data:")) return rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

// Parses source map JSON, dropping the `)]}'` XSSI guard line the spec allows.
function parseSourceMap(text) {
  try {
    return JSON.parse(text.startsWith(")]}'") ? text.slice(text.indexOf("\n") + 1) : text);
  } catch {
    return null;
  }
}

function decodeDataMap(url) {
  const b64 = url.match(/^data:application\/json(?:;[^,]*)?;base64,(.*)$/);
  if (b64) {
    try {
      return parseSourceMap(base64ToText(b64[1]));
    } catch {
      return null;
    }
  }
  const utf = url.match(/^data:application\/json(?:;[^,]*)?,(.*)$/);
  if (utf) {
    try {
      return parseSourceMap(decodeURIComponent(utf[1]));
    } catch {
      return null;
    }
  }
  return null;
}

async function loadMap(mapURL, resourceMap) {
  if (isBlacklistedResourceURL(mapURL)) return null;
  if (mapURL.startsWith("data:")) return decodeDataMap(mapURL);

  const res = resourceMap.get(mapURL);
  if (res) {
    const decoded = decodeResource(await getResourceContent(res));
    const map = decoded ? parseSourceMap(decoded) : null;
    if (map) return map;
    // Otherwise fall through to the network.
  }

  if (!isFetchableURL(mapURL)) return null;

  try {
    // Read as text (not "json") so parseSourceMap can strip an XSSI prefix.
    const text = await fetchWithTimeout(mapURL, NETWORK_CALL_TIMEOUT_MS, "text");
    return text == null ? null : parseSourceMap(text);
  } catch {
    return null;
  }
}

function normalizePath(raw) {
  const p = raw
    .replace(/^webpack(-internal)?:\/\/+/, "")
    .replace(/^[a-z]+:\/\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "");
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const cleaned = parts.join("/");
  return cleaned || null;
}

// vue-loader emits virtual chunks per SFC, and their display paths collide because the URL
// query (?vue&type=X or a webpack hash like ?5e8e) is stripped by normalizePath. Chunks are
// classified by query first, then by content sniffing (opaque hash queries), and non-canonical
// ones get a suffix: foo.template.vue, foo.script.vue, foo.style.vue, foo.proxy.vue.
// The canonical SFC keeps foo.vue.
function vueChunkSuffix(raw, content) {
  const q = raw.match(/[?&]vue&type=([a-zA-Z][\w-]*)/);
  if (q) return q[1].toLowerCase();
  if (typeof content !== "string") return null;
  const head = content.slice(0, 4096);
  if (/^\s*<template[\s>]/.test(head) || /<\/template>\s*<script/.test(head)) return null;
  if (/\bvar\s+render\s*=\s*function/.test(head) && /staticRenderFns/.test(head)) return "template";
  if (/import\s+.+\?vue&type=template/.test(head) && /\?vue&type=script/.test(head)) return "proxy";
  if (/stylePostLoader/.test(head)) return "style";
  if (/^\s*export\s+\*\s+from\s+["'][^"']*\?vue&type=style/.test(head)) return "style";
  if (/\?vue&type=script/.test(head)) return "script";
  return null;
}

function insertSuffixBeforeExt(path, suffix) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return path + "." + suffix;
  return path.slice(0, dot) + "." + suffix + path.slice(dot);
}

function disambiguatePath(basePath, raw, content, tree) {
  const vueType = vueChunkSuffix(raw, content);
  const candidate = vueType ? insertSuffixBeforeExt(basePath, vueType) : basePath;
  if (!tree[candidate]) return candidate;
  let i = 2;
  let next;
  do {
    next = insertSuffixBeforeExt(candidate, String(i));
    i++;
  } while (tree[next]);
  return next;
}

// True for sources like `src/a.ts` or `../a.ts`; false for `/abs/a.ts` and `webpack://...`.
function isRelativeSource(raw) {
  return !raw.startsWith("/") && !/^[a-z][\w+.-]*:/i.test(raw);
}

// Absolute URL of a source: sourceRoot resolves against the map URL, the source against that.
function resolveSourceURL(raw, sourceRoot, base) {
  try {
    return new URL(raw, new URL(sourceRoot, base)).href;
  } catch {
    return raw;
  }
}

// Adds a source map's files to state.sourceTree and returns how many are new. Index maps
// (`sections`) are walked recursively with the outer map's URL.
function addMapToTree(map, scriptURL, mapURL) {
  if (!map || typeof map !== "object") return 0;
  if (Array.isArray(map.sections)) {
    let added = 0;
    for (const section of map.sections) added += addMapToTree(section?.map, scriptURL, mapURL);
    return added;
  }
  if (!Array.isArray(map.sources)) return 0;
  const sourceRoot = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  // Inline data: maps have no usable base URL; their sources are relative to the script.
  const inline = mapURL.startsWith("data:");
  const base = inline ? scriptURL : mapURL;
  // Keys stay short for inline maps, whose URL can be megabytes long.
  const mapKey = inline ? "data:" : mapURL;
  let added = 0;
  for (let i = 0; i < map.sources.length; i++) {
    const raw = map.sources[i];
    if (typeof raw !== "string" || !raw) continue;
    const rooted =
      sourceRoot && isRelativeSource(raw) ? sourceRoot.replace(/\/*$/, "/") + raw : raw;
    const cleanPath = normalizePath(rooted);
    if (!cleanPath) continue;
    const content = typeof map.sourcesContent?.[i] === "string" ? map.sourcesContent[i] : null;
    // Without embedded content, fetchStatus stays null so the on-demand fetch runs.
    const fetchStatus = content != null ? "ok" : null;
    const captureKey = `${scriptURL}\0${mapKey}\0${raw}`;
    const existing = state.sourceByCaptureKey.get(captureKey);
    if (existing) {
      // Only reached when the script changed since its last scan. Keep user edits.
      if (!existing.edited) {
        existing.content = content;
        existing.fetchStatus = fetchStatus;
      }
      continue;
    }
    const path = disambiguatePath(cleanPath, raw, content, state.sourceTree);
    const entry = {
      content,
      sourceURL: resolveSourceURL(raw, sourceRoot, base),
      scriptURL,
      mapURL,
      fetchStatus,
    };
    state.sourceTree[path] = entry;
    state.sourceByCaptureKey.set(captureKey, entry);
    added++;
  }
  return added;
}
