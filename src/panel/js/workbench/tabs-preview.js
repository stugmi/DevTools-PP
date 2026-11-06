"use strict";

// Editor tabs and file preview: open/pin/close tabs, render a selected file or
// request, and the footer script/map links.
// Loaded after tree.js and discovery.js, before search.js and keyboard.js.

const PIN_SVG = `<svg class="tab-pin-icon" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M10.97 1.47a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1 0 1.06l-2.06 2.06 1.06 1.06a.75.75 0 0 1-1.06 1.06l-1.06-1.06-2.5 2.5.81.81a.75.75 0 1 1-1.06 1.06l-2.5-2.5L2.78 13.97a.75.75 0 0 1-1.06-1.06l3.38-3.38-2.5-2.5a.75.75 0 1 1 1.06-1.06l.81.81 2.5-2.5L5.91 3.22a.75.75 0 0 1 1.06-1.06L8.03 3.22 10.09 1.16z"/>
</svg>`;

// -- Tabs --

// Request tabs show the last meaningful URL path segment instead of the export
// path (e.g. "backend-api/f/conversation/prepare.json.request.json").
function requestTabLabel(path) {
  const entry = state.requestTree[path];
  const url = entry?._record?.request?.url;
  if (!url) return path.split("/").pop() || path;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.pop() || parsed.hostname;
  } catch {
    return path.split("/").pop() || path;
  }
}

// `options.newTab` always opens (or pins) a dedicated tab instead of reusing
// the italic "preview" tab.
function openFile(path, section, position, options = {}) {
  switchWorkspace(workspaceForSection(section));
  const id = tabId(path, section);
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    if (options.newTab) existing.pinned = true;
    state.activeTabId = id;
    renderTabs();
    selectFile(path, section, position);
    return;
  }

  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active && !active.pinned && !options.newTab) {
    active.id = id;
    active.path = path;
    active.section = section;
    active.dirty = false;
    state.activeTabId = id;
  } else {
    state.tabs.push({ id, path, section, pinned: Boolean(options.newTab) });
    state.activeTabId = id;
  }
  renderTabs();
  selectFile(path, section, position);
}

function pinTab(id, forcePinned) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  t.pinned = forcePinned == null ? !t.pinned : forcePinned;
  renderTabs();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const closedWorkspace = workspaceForSection(state.tabs[idx].section);
  state.tabs.splice(idx, 1);
  SourceEditor.disposeDocument(id);
  if (state.activeTabId === id) {
    const visible = tabsForWorkspace(closedWorkspace);
    if (visible.length) {
      const next = visible[visible.length - 1];
      state.activeTabId = next.id;
      renderTabs();
      selectFile(next.path, next.section);
    } else {
      state.activeTabId = null;
      state.selectedPath = null;
      state.selectedSection = null;
      renderTabs();
      resetPreview();
      // refresh tree to drop selected highlight
      if (state.treeModel || state.rawTreeModel || state.requestTreeModel) renderTree();
    }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  el.previewTabs.innerHTML = "";
  const visibleTabs = tabsForWorkspace(state.workspace);
  if (visibleTabs.length === 0) {
    const ph = document.createElement("span");
    ph.className = "preview-tabs-empty";
    ph.textContent = "Select an item to preview";
    el.previewTabs.appendChild(ph);
    return;
  }
  for (const t of visibleTabs) {
    const tabEl = document.createElement("div");
    tabEl.className = "preview-tab";
    if (t.id === state.activeTabId) tabEl.classList.add("active");
    if (t.pinned) tabEl.classList.add("pinned");
    else tabEl.classList.add("preview");
    tabEl.dataset.tabId = t.id;
    const sectionLabel =
      t.section === "mapped" ? "mapped" : t.section === "requests" ? "request" : "raw";
    const titlePath =
      t.section === "requests"
        ? state.requestTree[t.path]?._record?.request?.url || t.path
        : t.path;
    tabEl.title =
      `[${sectionLabel}] ` + titlePath + (t.pinned ? "" : " — preview tab (double-click to pin)");

    const filename =
      t.section === "requests" ? requestTabLabel(t.path) : t.path.split("/").pop() || t.path;

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = filename + (t.dirty ? " •" : "");

    const close = document.createElement("span");
    close.className = "tab-close";
    close.title = "Close (middle-click also closes)";
    close.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;

    if (t.pinned) {
      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.title = "Pinned (double-click to unpin)";
      pin.innerHTML = PIN_SVG;
      tabEl.appendChild(pin);
    }
    tabEl.appendChild(name);
    tabEl.appendChild(close);

    tabEl.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) {
        closeTab(t.id);
        return;
      }
      if (state.activeTabId !== t.id) {
        state.activeTabId = t.id;
        renderTabs();
        selectFile(t.path, t.section);
      }
    });
    tabEl.addEventListener("dblclick", (e) => {
      if (e.target.closest(".tab-close")) return;
      pinTab(t.id);
    });
    tabEl.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(t.id);
      }
    });

    el.previewTabs.appendChild(tabEl);
  }
}

// -- File preview --

function urlBasename(u) {
  if (!u) return "—";
  if (u.startsWith("data:")) return "inline data: URI";
  try {
    const parsed = new URL(u);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || parsed.hostname || u;
  } catch {
    return u;
  }
}

function setFooterLink(link, url, emptyText = "") {
  link.textContent = url ? urlBasename(url) : emptyText;
  link.dataset.url = url || "";
  link.title = url
    ? `${url}\nClick to preview · ${Keybinds.label("link.openInTab")} to open in a new tab`
    : "";
  link.classList.toggle("is-link", Boolean(url));
  if (url) link.tabIndex = 0;
  else link.removeAttribute("tabindex");
}

function setFooterURLs(entry) {
  setFooterLink(el.previewScriptUrl, entry.scriptURL, "—");
  if (entry.mapURL) {
    el.previewMapBlock.style.display = "inline-flex";
    setFooterLink(el.previewMapUrl, entry.mapURL);
  } else {
    el.previewMapBlock.style.display = "none";
    setFooterLink(el.previewMapUrl, "");
  }
}

// `virtual` renders into the read-only "virtual::preview" document instead of the selected
// file's own editor model (footer link targets and loading notes).
function renderContent(content, lang, badgeFallback, position, virtual = false) {
  let display = position?.formattedContent || content;
  if (!position?.formattedContent && state.prettyView && canPrettyFormat(lang)) {
    const r = tryPretty(content, lang);
    if (r.ok) display = r.content;
  }
  state.lastPreviewOriginal = content;
  state.lastPreviewText = display;
  state.lastPreviewLang = lang;
  state.lastPreviewBadge = badgeFallback || null;

  el.previewActions.classList.remove("request-actions");
  el.previewActions.style.display = "flex";
  el.previewFooter.classList.remove("request-actions");
  el.previewPlaceholder.style.display = "none";
  el.previewImageWrap.style.display = "none";
  el.requestDetail.hidden = true;
  el.editorContainer.style.display = "block";

  updatePrettyButton(lang);

  const isFile = !virtual && state.selectedPath && state.selectedSection;
  const editorDoc = isFile
    ? {
        id: tabId(state.selectedPath, state.selectedSection),
        path: state.selectedPath,
        section: state.selectedSection,
        content: display,
        language: lang || "plaintext",
      }
    : {
        id: "virtual::preview",
        path: "preview.txt",
        section: "virtual",
        readOnly: true,
        content: display,
        language: lang || "plaintext",
      };
  SourceEditor.show(editorDoc, position).catch((error) => {
    setStatus("inactive", `Editor failed: ${error.message}`);
  });

  const lines = display.split("\n").length;
  const bytes = new TextEncoder().encode(display).length;
  el.previewLangBadge.textContent =
    (lang && LANG_LABELS[lang]) || badgeFallback || (lang || "TXT").toUpperCase();
  el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(bytes)}`;
  el.previewFooter.style.display = "flex";
}

// Fills the preview placeholder (icon stays in the markup): the first span holds the message,
// extra lines are appended after it and dropped on the next call. `missing` tints it red.
function showPlaceholder(message, extras = [], missing = false) {
  const ph = el.previewPlaceholder;
  ph.style.display = "flex";
  ph.classList.toggle("missing", missing);
  ph.querySelector("span").textContent = message;
  for (const old of ph.querySelectorAll(".placeholder-extra")) old.remove();
  for (const { text, mono } of extras) {
    const line = document.createElement("span");
    line.className = mono ? "placeholder-extra mono" : "placeholder-extra";
    line.textContent = text;
    ph.appendChild(line);
  }
}

function resetPreview() {
  state.lastPreviewText = "";
  state.lastPreviewOriginal = "";
  el.editorContainer.style.display = "none";
  SourceEditor.hide().catch(() => {});
  el.requestDetail.hidden = true;
  el.previewImageWrap.style.display = "none";
  el.previewFooter.style.display = "none";
  el.previewActions.style.display = "none";
  showPlaceholder("No item selected");
}

// `options.keepList` re-shows a tab's document (workspace restore) without touching the list
// focus or a batch selection: each list keeps its own selection independent of the document.
async function selectFile(path, section, position, { keepList = false } = {}) {
  // Re-rendering the document that is already displayed (live capture updates) must not
  // move the list focus or collapse a multi-selection.
  const redisplay = keepList || (state.selectedSection === section && state.selectedPath === path);
  state.selectedPath = path;
  state.selectedSection = section;

  // Each list view keeps its own highlight; only the section's own view is touched.
  if (section === "requests") {
    if (!redisplay || state.listSelection.network === null) RequestSelection.focus(path);
    revealFileInTree(path, section);
    syncNetworkRowSelection();
  } else {
    if (!keepList || !state.listSelection.files) state.listSelection.files = { path, section };
    const focused = state.listSelection.files;
    document
      .querySelectorAll(".tree-node.selected")
      .forEach((node) => node.classList.remove("selected"));
    const row = revealFileInTree(focused.path, focused.section);
    if (row) row.classList.add("selected");
  }

  const tree = treeFor(section);
  const entry = tree[path];
  if (!entry) return;

  setFooterURLs(entry);
  if (section === "requests") {
    await showSelectedRequestTab();
    return;
  }

  if (isImagePath(path, entry)) {
    renderImage(entry, path);
    return;
  }

  if (
    entry.content == null &&
    entry.fetchStatus !== "missing" &&
    entry.sourceURL &&
    !entry.sourceURL.startsWith("data:")
  ) {
    renderVirtual("Loading…", null, "…");
    const fetched = await loadRawByURL(entry.sourceURL, entry._resource);
    if (state.selectedPath !== path || state.selectedSection !== section) return;
    if (fetched != null) {
      entry.content = fetched;
      entry.fetchStatus = "ok";
    } else {
      entry.fetchStatus = "missing";
      renderTree();
    }
  }

  if (entry.content != null) {
    const lang = detectEntryLang(path, entry);
    renderContent(entry.content, lang, badgeForPath(path, lang), position);
  } else {
    state.lastPreviewText = "";
    state.lastPreviewOriginal = "";
    el.previewActions.style.display = "flex";
    el.previewFooter.style.display = "flex";
    el.editorContainer.style.display = "none";
    SourceEditor.hide().catch(() => {});
    el.previewPlaceholder.style.display = "flex";
    const failed = entry.fetchStatus === "missing";
    const headline = failed
      ? section === "raw" || section === "requests"
        ? "Failed to fetch resource"
        : "Source not embedded and could not be fetched"
      : "No source content embedded in map";
    const extras = [{ text: entry.sourceURL || "", mono: true }];
    extras.push({ text: "Will be exported as a placeholder file." });
    showPlaceholder(headline, extras, failed);
    el.previewLangBadge.textContent = "";
    el.previewMeta.textContent = "";
  }
}

function renderImage(entry, path) {
  state.lastPreviewText = "";
  state.lastPreviewOriginal = "";
  el.previewActions.style.display = "flex";
  el.previewActions.classList.remove("request-actions");
  el.previewFooter.classList.remove("request-actions");
  el.previewPlaceholder.style.display = "none";
  el.editorContainer.style.display = "none";
  SourceEditor.hide().catch(() => {});
  el.requestDetail.hidden = true;
  el.previewImageWrap.style.display = "flex";

  const url = entry.sourceURL || entry.scriptURL || "";
  const usable = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:");

  if (usable) {
    el.previewImage.style.display = "block";
    el.previewImage.src = url;
    el.previewImage.alt = path;
    el.previewImage.onload = () => {
      const w = el.previewImage.naturalWidth;
      const h = el.previewImage.naturalHeight;
      el.previewImageMeta.textContent = `${w} × ${h}`;
    };
    el.previewImage.onerror = () => {
      el.previewImage.style.display = "none";
      el.previewImageMeta.textContent = "Failed to load image";
    };
  } else {
    el.previewImage.style.display = "none";
    el.previewImage.removeAttribute("src");
    el.previewImageMeta.textContent = "Image source unavailable (" + (url || "—") + ")";
  }

  const ext = extensionForPath(path).toUpperCase() || "IMG";
  el.previewLangBadge.textContent = ext;
  el.previewMeta.textContent = path.split("/").pop();
  el.previewFooter.style.display = "flex";
}

// Loads a file's text from the DevTools resource, falling back to a network fetch. Failures
// are cached as `null` too, so a missing file is not re-requested until the cache is reset.
async function loadRawByURL(url, resource) {
  if (isBlacklistedResourceURL(url)) return null;
  if (state.rawCache.has(url)) return state.rawCache.get(url);

  let r = resource;
  if (!r) {
    const location = state.rawByURL.get(url);
    r = location && treeFor(location.section)[location.path]?._resource;
  }
  if (!r) {
    const resources = await getResources();
    r = resources.find((item) => item.url === url);
  }
  let content = null;
  if (r) {
    content = decodeResource(await getResourceContent(r));
  }
  if (!content && isFetchableURL(url)) {
    try {
      content = await fetchWithTimeout(url, NETWORK_CALL_TIMEOUT_MS, "text");
    } catch {
      content = null;
    }
  }
  state.rawCache.set(url, content);
  return content;
}

// Runs `worker(item)` over `items` with at most `limit` in flight.
async function runLimited(items, limit, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// Loads missing content for tree entries (bounded concurrency). Sets `content` and
// `fetchStatus` "ok" on success and "missing" on failure so later calls skip them.
async function ensureContent(entries, { concurrency = 6, onProgress } = {}) {
  const todo = entries.filter(
    (e) =>
      e &&
      e.content == null &&
      e.fetchStatus !== "missing" &&
      e.sourceURL &&
      !e.sourceURL.startsWith("data:")
  );
  let done = 0;
  await runLimited(todo, concurrency, async (entry) => {
    let content = null;
    try {
      content = await loadRawByURL(entry.sourceURL, entry._resource);
    } catch {
      content = null;
    }
    if (content != null) {
      entry.content = content;
      entry.fetchStatus = "ok";
    } else {
      entry.fetchStatus = "missing";
    }
    if (onProgress) onProgress(++done, todo.length);
  });
}

// Shows a transient (non-file) document, such as a footer link target or a loading note, in
// the read-only virtual preview so it never touches a file's model or content.
function renderVirtual(content, lang, badgeFallback) {
  renderContent(content, lang, badgeFallback, undefined, true);
}

async function showRawFile(url, kind) {
  if (!url) return;

  if (url.startsWith("data:")) {
    if (kind === "map") {
      const map = decodeDataMap(url);
      if (map) {
        renderVirtual(JSON.stringify(map, null, 2), "json", "JSON");
      }
    }
    return;
  }

  renderVirtual("Loading…", null, "…");
  const content = await loadRawByURL(url);
  if (content == null) {
    renderVirtual("// Failed to load resource.", null, "ERR");
    return;
  }

  if (kind === "map") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // not JSON, show raw
    }
    renderVirtual(pretty, "json", "JSON");
  } else {
    const lang =
      langFromContentType(state.contentTypesByURL.get(url)) || sniffLang(content) || "javascript";
    renderVirtual(content, lang, (lang && LANG_LABELS[lang]) || "JS");
  }
}

// Ctrl/Cmd+click opens the linked file in its own tab; a plain click previews
// it in place.
function openFooterLink(url, kind, event) {
  if (!url) return;
  const newTab = event.ctrlKey || event.metaKey;
  if (!newTab) {
    showRawFile(url, kind);
    return;
  }
  const location = state.rawByURL.get(url);
  if (location && treeFor(location.section)[location.path]) {
    openFile(location.path, location.section, undefined, { newTab: true });
  } else if (state.selectedSection === "requests") {
    // A request's "from" is the request itself, so just keep its tab open.
    if (state.activeTabId) pinTab(state.activeTabId, true);
  } else if (/^https?:/i.test(url)) {
    window.open(url, "_blank", "noopener");
  } else {
    showRawFile(url, kind);
  }
}

for (const [link, kind] of [
  [el.previewScriptUrl, "script"],
  [el.previewMapUrl, "map"],
]) {
  link.addEventListener("click", (event) => openFooterLink(link.dataset.url, kind, event));
  link.addEventListener("keydown", (event) => {
    if (Keybinds.matches(event, "link.open")) openFooterLink(link.dataset.url, kind, event);
  });
}

// Toggles the pretty-printed view for source files, or the Format toggle for
// request/response bodies. Bound to the file.format keybind in keyboard.js.
function formatCurrentFile() {
  if (state.selectedSection === "requests") {
    setRequestFormat(!state.requestDetailFormat);
    return;
  }
  // Nothing to format: decline so the key reaches DevTools.
  if (!state.selectedPath || el.btnPretty.disabled) return false;
  el.btnPretty.click();
}
