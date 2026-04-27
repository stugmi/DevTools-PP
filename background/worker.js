// Background service worker
// Manages debugger sessions and source map fetching across tabs

const activeSessions = new Map(); // tabId -> session info

// ── Debugger attachment ──────────────────────────────────────────────────────

async function attachDebugger(tabId) {
  if (activeSessions.has(tabId)) return activeSessions.get(tabId);

  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      const session = { tabId, scripts: new Map() };
      activeSessions.set(tabId, session);

      // Enable Debugger domain
      chrome.debugger.sendCommand({ tabId }, "Debugger.enable", {}, () => {
        resolve(session);
      });
    });
  });
}

async function detachDebugger(tabId) {
  if (!activeSessions.has(tabId)) return;
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      activeSessions.delete(tabId);
      resolve();
    });
  });
}

// ── Script / source map collection ──────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Debugger.scriptParsed") return;
  const { tabId } = source;
  const session = activeSessions.get(tabId);
  if (!session) return;

  if (params.sourceMapURL) {
    session.scripts.set(params.scriptId, {
      url: params.url,
      sourceMapURL: params.sourceMapURL,
      scriptId: params.scriptId,
    });
  }
});

// ── Resolve a source map URL relative to the script URL ─────────────────────

function resolveSourceMapURL(scriptURL, sourceMapURL) {
  if (!sourceMapURL) return null;
  if (sourceMapURL.startsWith("data:")) return sourceMapURL;
  if (sourceMapURL.startsWith("http://") || sourceMapURL.startsWith("https://")) {
    return sourceMapURL;
  }
  try {
    return new URL(sourceMapURL, scriptURL).href;
  } catch {
    return sourceMapURL;
  }
}

// ── Fetch a source map (data URI or network) ─────────────────────────────────

async function fetchSourceMap(scriptURL, sourceMapURL) {
  const resolved = resolveSourceMapURL(scriptURL, sourceMapURL);
  if (!resolved) return null;

  if (resolved.startsWith("data:application/json;base64,")) {
    const b64 = resolved.slice("data:application/json;base64,".length);
    const text = atob(b64);
    return JSON.parse(text);
  }

  const resp = await fetch(resolved);
  if (!resp.ok) return null;
  return resp.json();
}

// ── Build the source tree from all collected scripts ─────────────────────────

async function buildSourceTree(tabId) {
  const session = activeSessions.get(tabId);
  if (!session) return null;

  const tree = {}; // path -> { content, url }

  for (const [, script] of session.scripts) {
    let map;
    try {
      map = await fetchSourceMap(script.url, script.sourceMapURL);
    } catch {
      continue;
    }
    if (!map || !map.sources) continue;

    for (let i = 0; i < map.sources.length; i++) {
      const rawPath = map.sources[i];
      if (!rawPath) continue;

      // Normalize: strip webpack:// / webpack-internal:// prefixes and leading slashes
      let cleanPath = rawPath
        .replace(/^webpack(-internal)?:\/\/\/?/, "")
        .replace(/^\//, "")
        .replace(/\.\.\//g, "")
        .replace(/\?.*$/, "");

      if (!cleanPath || cleanPath === "." || cleanPath.startsWith("node_modules/")) continue;

      const content =
        map.sourcesContent && map.sourcesContent[i] != null
          ? map.sourcesContent[i]
          : null;

      tree[cleanPath] = {
        content,
        sourceURL: rawPath,
        scriptURL: script.url,
      };
    }
  }

  return tree;
}

// ── Message handler from panel ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ATTACH") {
    attachDebugger(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "DETACH") {
    detachDebugger(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "GET_SCRIPTS") {
    const session = activeSessions.get(msg.tabId);
    if (!session) {
      sendResponse({ scripts: [] });
      return true;
    }
    const scripts = [...session.scripts.values()];
    sendResponse({ scripts });
    return true;
  }

  if (msg.type === "BUILD_TREE") {
    buildSourceTree(msg.tabId)
      .then((tree) => sendResponse({ tree }))
      .catch((e) => sendResponse({ tree: null, error: e.message }));
    return true;
  }

  if (msg.type === "FETCH_SOURCE_MAP") {
    fetchSourceMap(msg.scriptURL, msg.sourceMapURL)
      .then((map) => sendResponse({ map }))
      .catch((e) => sendResponse({ map: null, error: e.message }));
    return true;
  }
});

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSessions.has(tabId)) {
    detachDebugger(tabId).catch(() => {});
  }
});
