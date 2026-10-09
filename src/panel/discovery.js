"use strict";

// ── Resource discovery via DevTools API (no debugger attach) ────────────────

// chrome.devtools.network's getContent() callbacks (and fetch() to sites the
// page references) can hang forever instead of erroring -- e.g. an evicted
// HAR body, a streaming response, or an unresponsive sourcemap/API host. Left
// unbounded, those pile up for as long as DevTools stays open and can exhaust
// the browser's shared connection pool, stalling unrelated tabs. Every
// network/CDP round trip in this file must go through a hard timeout.
const NETWORK_CALL_TIMEOUT_MS = 8000;
// Reassigned in capture.js's PANEL_SHOWN/PANEL_HIDDEN handler -- looks
// unused/never-reassigned from this file's own isolated view, but it truly
// needs to stay `let`.
// eslint-disable-next-line prefer-const
let panelVisible = false;

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isBlacklistedResourceURL(url) {
  if (!url) return false;
  return RESOURCE_URL_BLACKLIST.some((prefix) => url === prefix || url.startsWith(prefix + "/"));
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

function decodeResource({ content, encoding }) {
  if (content == null) return null;
  if (encoding === "base64") {
    try {
      return atob(content);
    } catch {
      return null;
    }
  }
  return content;
}

const SOURCEMAP_RE = /[/][/*][#@]\s*sourceMappingURL=([^\s'"*]+)/;

function extractSourceMapURL(scriptContent) {
  const tail = scriptContent.length > 8192 ? scriptContent.slice(-8192) : scriptContent;
  const m = tail.match(SOURCEMAP_RE);
  return m ? m[1].trim() : null;
}

function resolveURL(base, rel) {
  if (rel.startsWith("data:")) return rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function decodeDataMap(url) {
  const b64 = url.match(/^data:application\/json(?:;[^,]*)?;base64,(.*)$/);
  if (b64) {
    try {
      return JSON.parse(atob(b64[1]));
    } catch {
      return null;
    }
  }
  const utf = url.match(/^data:application\/json(?:;[^,]*)?,(.*)$/);
  if (utf) {
    try {
      return JSON.parse(decodeURIComponent(utf[1]));
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
    if (decoded) {
      try {
        return JSON.parse(decoded);
      } catch {
        // fall through to network
      }
    }
  }

  if (!isFetchableURL(mapURL)) return null;

  try {
    const r = await fetchWithTimeout(mapURL, NETWORK_CALL_TIMEOUT_MS);
    if (!r.ok) return null;
    return await r.json();
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

// vue-loader emits virtual chunks per SFC. Display paths collide because the URL
// query (?vue&type=X or webpack hash like ?5e8e) is stripped during normalization.
// We classify chunks by query first, then by content sniffing (covers builds that
// use opaque hash queries), and suffix non-canonical chunks: foo.template.vue,
// foo.script.vue, foo.style.vue, foo.proxy.vue. Canonical SFC keeps foo.vue.
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

function addMapToTree(map, scriptURL, mapURL) {
  if (!map || !Array.isArray(map.sources)) return 0;
  let added = 0;
  for (let i = 0; i < map.sources.length; i++) {
    const raw = map.sources[i];
    if (!raw) continue;
    const cleanPath = normalizePath(raw);
    if (!cleanPath) continue;
    const content =
      map.sourcesContent && map.sourcesContent[i] != null ? map.sourcesContent[i] : null;
    const captureKey = `${scriptURL}\0${mapURL}\0${raw}`;
    const existing = Object.values(state.sourceTree).find(
      (entry) => entry._captureKey === captureKey
    );
    if (existing) {
      existing.content = content;
      existing.fetchStatus = content != null ? "ok" : "missing";
      continue;
    }
    const path = disambiguatePath(cleanPath, raw, content, state.sourceTree);
    state.sourceTree[path] = {
      content,
      sourceURL: raw,
      scriptURL,
      mapURL,
      fetchStatus: content != null ? "ok" : "missing",
      _captureKey: captureKey,
    };
    added++;
  }
  return added;
}
