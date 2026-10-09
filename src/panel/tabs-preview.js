"use strict";

const PIN_SVG = `<svg class="tab-pin-icon" width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M10.97 1.47a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1 0 1.06l-2.06 2.06 1.06 1.06a.75.75 0 0 1-1.06 1.06l-1.06-1.06-2.5 2.5.81.81a.75.75 0 1 1-1.06 1.06l-2.5-2.5L2.78 13.97a.75.75 0 0 1-1.06-1.06l3.38-3.38-2.5-2.5a.75.75 0 1 1 1.06-1.06l.81.81 2.5-2.5L5.91 3.22a.75.75 0 0 1 1.06-1.06L8.03 3.22 10.09 1.16z"/>
</svg>`;

// ── Tabs ─────────────────────────────────────────────────────────────────────

// Request tabs shouldn't show the export-path (used for ZIP/TAR file names,
// e.g. "backend-api/f/conversation/prepare.json.request.json") as their tab
// label -- use the last meaningful URL path segment instead.
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

// ── File preview ─────────────────────────────────────────────────────────────

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
  link.title = url ? `${url}\nClick to preview · Ctrl+Click to open in a new tab` : "";
  link.classList.toggle("is-link", Boolean(url));
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

function renderContent(content, lang, badgeFallback, position) {
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

  const document = {
    id:
      state.selectedPath && state.selectedSection
        ? tabId(state.selectedPath, state.selectedSection)
        : "virtual::preview",
    path: state.selectedPath || "preview.txt",
    section: state.selectedSection || "virtual",
    content: display,
    language: lang || "plaintext",
  };
  SourceEditor.show(document, position).catch((error) => {
    setStatus("inactive", `Editor failed: ${error.message}`);
  });

  const lines = display.split("\n").length;
  const bytes = new TextEncoder().encode(display).length;
  el.previewLangBadge.textContent =
    (lang && LANG_LABELS[lang]) || badgeFallback || (lang || "TXT").toUpperCase();
  el.previewMeta.textContent = `${lines.toLocaleString()} lines · ${formatBytes(bytes)}`;
  el.previewFooter.style.display = "flex";
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
  el.previewPlaceholder.style.display = "flex";
  el.previewPlaceholder.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <path d="M8 4h10l6 6v18H8V4z" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
      <path d="M18 4v6h6" stroke="#2a3a4a" stroke-width="1.2" fill="none"/>
      <path d="M11 14h10M11 17h10M11 20h7" stroke="#2a3a4a" stroke-width="1" stroke-linecap="round"/>
    </svg>
    <span>No item selected</span>
  `;
}

async function selectFile(path, section, position) {
  state.selectedPath = path;
  state.selectedSection = section;

  document
    .querySelectorAll(".tree-node.selected, .network-row.selected")
    .forEach((node) => node.classList.remove("selected"));
  const row = revealFileInTree(path, section);
  if (row) row.classList.add("selected");

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
    renderContent("Loading…", null, "…");
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
    el.previewPlaceholder.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <path d="M8 4h10l6 6v18H8V4z" stroke="${failed ? "#5a3a3a" : "#2a3a4a"}" stroke-width="1.2" fill="none"/>
        <path d="M18 4v6h6" stroke="${failed ? "#5a3a3a" : "#2a3a4a"}" stroke-width="1.2" fill="none"/>
      </svg>
      <span style="color: ${failed ? "var(--red)" : "var(--text-dim)"}; font-size: 11px;">${escapeHtml(headline)}</span>
      <span style="color: var(--text-dim); font-size: 10px; font-family: var(--font-mono)">${escapeHtml(entry.sourceURL || "")}</span>
      <span style="color: var(--text-dim); font-size: 10px;">Will be exported as a placeholder file.</span>
    `;
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
  if (!content) {
    if (isFetchableURL(url)) {
      try {
        const resp = await fetchWithTimeout(url, NETWORK_CALL_TIMEOUT_MS);
        if (resp.ok) content = await resp.text();
      } catch {
        content = null;
      }
    }
  }
  if (content != null) state.rawCache.set(url, content);
  return content;
}

async function showRawFile(url, kind) {
  if (!url) return;

  if (url.startsWith("data:")) {
    if (kind === "map") {
      const map = decodeDataMap(url);
      if (map) {
        renderContent(JSON.stringify(map, null, 2), "json", "JSON");
      }
    }
    return;
  }

  renderContent("Loading…", null, "…");
  const content = await loadRawByURL(url);
  if (content == null) {
    renderContent("// Failed to load resource.", null, "ERR");
    return;
  }

  if (kind === "map") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // not JSON, show raw
    }
    renderContent(pretty, "json", "JSON");
  } else {
    const lang =
      langFromContentType(state.contentTypesByURL.get(url)) || sniffLang(content) || "javascript";
    renderContent(content, lang, (lang && LANG_LABELS[lang]) || "JS");
  }
}

// Ctrl/Cmd+click opens the linked file in its own tab; a plain click previews
// it in place (the original behaviour).
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
    // A request's "from" is the request itself -- just keep its tab open.
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
    if (event.key === "Enter") openFooterLink(link.dataset.url, kind, event);
  });
}

// Format the open file (Ctrl+Shift+F): toggles the pretty-printed view for
// source files and the Format toggle for request/response bodies.
function formatCurrentFile() {
  if (state.selectedSection === "requests") {
    setRequestFormat(!state.requestDetailFormat);
    return;
  }
  if (!state.selectedPath || el.btnPretty.disabled) return;
  el.btnPretty.click();
}
