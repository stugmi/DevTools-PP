// Capture orchestration: full scans, tree rebuilds, reset, and the DevTools event listeners.
// Loaded after discovery.js, raw-capture.js and request-capture.js (registers listeners that
// use their functions) and before sources/tree.js.
"use strict";

// Scripts whose source maps are loaded at the same time during a scan.
const SCAN_CONCURRENCY = 4;
// A script whose content or map fails to load this often is skipped until the next page.
const MAX_SCAN_ATTEMPTS = 3;

function scriptScanFailed(url) {
  const attempts = (state.scanAttempts.get(url) || 0) + 1;
  state.scanAttempts.set(url, attempts);
  if (attempts >= MAX_SCAN_ATTEMPTS) state.scannedScripts.add(url);
}

// Maps one script's source map into the tree. A script counts as scanned only after a final
// outcome (no map comment, or map added); load failures are retried by later scans.
async function processScript(resource, resourceMap, gen) {
  const url = resource?.url;
  if (!url || isBlacklistedResourceURL(url) || state.scannedScripts.has(url)) return 0;

  const content = decodeResource(await getResourceContent(resource));
  if (gen !== state.scanGeneration) return 0;
  if (content == null) {
    scriptScanFailed(url);
    return 0;
  }
  // Unchanged since an earlier page (collect mode): its files are already in the tree.
  const signature = textSignature(content);
  if (state.scriptSignatures.get(url) === signature) {
    state.scannedScripts.add(url);
    return 0;
  }

  let added = 0;
  const smURL = extractSourceMapURL(content);
  if (smURL) {
    const mapURL = resolveURL(url, smURL);
    const map = await loadMap(mapURL, resourceMap);
    if (gen !== state.scanGeneration) return 0;
    if (!map) {
      scriptScanFailed(url);
      return 0;
    }
    added = addMapToTree(map, url, mapURL);
  }
  state.scannedScripts.add(url);
  state.scriptSignatures.set(url, signature);
  return added;
}

// Runs processScript over `scripts` with SCAN_CONCURRENCY workers while `live()` holds. A
// script that throws counts as a failed attempt and does not abort the scan.
async function processScripts(scripts, resourceMap, gen, live) {
  let next = 0;
  const worker = async () => {
    while (next < scripts.length && live()) {
      const script = scripts[next++];
      try {
        await processScript(script, resourceMap, gen);
      } catch (error) {
        console.warn(`Source Exporter: scanning ${script.url} failed`, error);
        if (gen === state.scanGeneration) scriptScanFailed(script.url);
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
}

// Never rejects. Stops writing as soon as the panel hides or the scan generation changes
// (reset, navigation), so a stale scan cannot fill the new page's state.
async function scanAll() {
  if (!state.panelVisible || state.scanning) return;
  const gen = state.scanGeneration;
  const live = () => gen === state.scanGeneration && state.panelVisible;
  state.scanning = true;
  setStatus(
    "connecting",
    state.collectAcrossNavigations ? "Collecting sources and requests…" : "Scanning sources…"
  );
  try {
    const [pageId, har] = await Promise.all([getInspectedPageId(), getHAR()]);
    if (!live()) return;
    if (pageId != null) state.scanPageId = pageId;
    updateContentTypesFromHAR(har);
    const resources = await getResources();
    if (!live()) return;
    const resourceMap = new Map(resources.map((r) => [r.url, r]));
    const scripts = [...resourceMap.values()].filter((r) => r.type === "script");

    syncRawTree(resources);
    captureRequestsFromHAR(har?.entries, true);

    await processScripts(scripts, resourceMap, gen, live);
    if (live()) rebuild();
  } catch (error) {
    if (live()) setStatus("inactive", `Scan failed: ${error.message}`);
  } finally {
    if (gen === state.scanGeneration) state.scanning = false;
  }
}

// Status bar text and the Export All button. Returns the per-section item counts.
function updateCaptureStatus() {
  const counts = {
    mapped: getItemsInSection("mapped").length,
    raw: getItemsInSection("raw").length,
    requests: getItemsInSection("requests").length,
  };
  const totalCapturedCount =
    Object.keys(state.sourceTree).length +
    Object.keys(state.rawTree).length +
    Object.keys(state.requestTree).length;

  if (totalCapturedCount === 0) {
    setStatus(
      "active",
      `${state.collectAcrossNavigations ? "Collecting" : "Watching"} — nothing to show`
    );
    el.btnExportAll.disabled = true;
  } else {
    const parts = [];
    if (state.showMapped) parts.push(`${counts.mapped} mapped`);
    if (state.showRaw) parts.push(`${counts.raw} raw`);
    parts.push(`${counts.requests} requests`);
    setStatus(
      "active",
      `${state.collectAcrossNavigations ? "Collecting across navigations" : "Watching"} — ${parts.join(", ")}`
    );
    el.btnExportAll.disabled = false;
  }
  return counts;
}

function rebuild() {
  // Authored files are grouped under the domain of the script they were mapped from
  // (entryHost prefers scriptURL over the map or source URL).
  state.treeModel = buildTreeModel(filteredTreeFor("mapped"), { groupByDomain: true });
  state.rawTreeModel = buildTreeModel(filteredTreeFor("raw"));
  state.requestTreeModel = buildTreeModel(filteredTreeFor("requests"));

  renderTree(updateCaptureStatus());
  renderNetworkTable();
  SourceEditor.scheduleProjectSync();
}

// Stops an in-flight scan: it sees the new generation after its next await and stops writing.
function cancelScan() {
  state.scanGeneration++;
  state.scanning = false;
}

function resetCapture() {
  cancelScan();
  Object.assign(state, createCaptureState());
  state.selectedPath = null;
  state.selectedSection = null;
  state.listSelection = { network: null, files: null };
  state.tabs = [];
  state.activeTabId = null;
  state.parkedActiveTabs = { network: null, files: null };
  openDirs.clear();
  userToggledDirs.clear();
  el.btnExportAll.disabled = true;
  el.emptyState.style.display = "flex";
  el.treeRoot.style.display = "none";
  SourceEditor.disposeAllModels();
  resetPreview();
  renderTabs();
  refreshNetwork();
}

// The inspected page navigated or reloaded. Without collect mode everything is dropped;
// with it the captured files stay and only this page's scan bookkeeping is cleared.
function handlePageChange() {
  if (!state.collectAcrossNavigations) {
    resetCapture();
    return;
  }
  cancelScan();
  state.scannedScripts.clear();
  state.scanAttempts.clear();
  state.rawCache = new Map();
}

// -- Live updates --
// Resource events only update lightweight metadata right away. Script body inspection waits
// until the page has gone quiet, so the panel never competes with a navigation in flight
// for DevTools resources.
let scriptScanTimer = null;
let rebuildTimer = null;

function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (state.panelVisible) rebuild();
  }, 100);
}

function scheduleScriptScan(delay = 1000) {
  clearTimeout(scriptScanTimer);
  scriptScanTimer = setTimeout(() => {
    scriptScanTimer = null;
    if (!state.panelVisible) return;
    if (state.scanning) {
      scheduleScriptScan(250);
      return;
    }
    scanAll();
  }, delay);
}

insp.onResourceAdded.addListener((resource) => {
  if (!resource || !state.panelVisible) return;
  if (addRawResource(resource)) scheduleRebuild();
  if (resource.type === "script") scheduleScriptScan();
});

network.onNavigated.addListener(() => {
  if (!state.panelVisible) return;
  handlePageChange();
  scheduleScriptScan();
});

network.onRequestFinished.addListener((request) => {
  if (!state.panelVisible) return;
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

// -- Panel visibility --
// The panel page can exist while another DevTools tab is focused. Stay passive until
// DevTools reports that Source Exporter is visible.

// Returning to the panel only rescans, keeping tabs and edits. onNavigated is ignored while
// hidden, so a page that reloaded or navigated meanwhile is detected here instead.
async function onPanelShown() {
  const pageId = await getInspectedPageId();
  if (!state.panelVisible) return;
  if (pageId != null && state.scanPageId != null && pageId !== state.scanPageId) {
    handlePageChange();
  }
  scheduleScriptScan(500);
}

window.addEventListener("message", (event) => {
  // Only this extension's DevTools page may toggle capture.
  if (event.origin !== location.origin) return;
  if (event.data?.type === "PANEL_SHOWN") {
    if (state.panelVisible) return;
    state.panelVisible = true;
    onPanelShown();
  }
  if (event.data?.type === "PANEL_HIDDEN") {
    state.panelVisible = false;
    clearTimeout(scriptScanTimer);
    scriptScanTimer = null;
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    closeQuickPicker();
  }
});

// The DevTools page may post PANEL_SHOWN before this script runs. Announce readiness so it
// repeats the message if the panel is visible.
chrome.runtime.sendMessage({ type: "PANEL_READY", tabId: insp.tabId }).catch(() => {
  // No DevTools page listening (it is being torn down).
});
