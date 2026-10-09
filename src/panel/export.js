"use strict";

// Which entries each kind of target shows. "Export all sources" is always last.
const CONTEXT_MENU_ITEMS = {
  file: ["ctxExportFile", "ctxCopyPath"],
  dir: ["ctxExportDir", "ctxCollapseAll", "ctxExpandAll", "ctxCopyPath"],
  section: ["ctxExportSection", "ctxCollapseAll", "ctxExpandAll"],
};

function showContextMenu(x, y, targetType) {
  const visible = new Set(CONTEXT_MENU_ITEMS[targetType] || []);
  for (const key of [
    "ctxExportFile",
    "ctxExportDir",
    "ctxExportSection",
    "ctxCollapseAll",
    "ctxExpandAll",
    "ctxCopyPath",
  ]) {
    el[key].style.display = visible.has(key) ? "block" : "none";
  }
  const section = state.contextTarget?.section;
  el.ctxExportSection.textContent =
    section === "mapped"
      ? "Export Authored"
      : section === "requests"
        ? "Export Requests"
        : "Export Deployed";
  el.ctxCopyPath.textContent = targetType === "dir" ? "Copy folder path" : "Copy file path";

  el.contextMenu.style.display = "block";
  const safeX = Math.max(4, Math.min(x, window.innerWidth - el.contextMenu.offsetWidth - 4));
  const safeY = Math.max(4, Math.min(y, window.innerHeight - el.contextMenu.offsetHeight - 4));
  el.contextMenu.style.left = safeX + "px";
  el.contextMenu.style.top = safeY + "px";
}

function hideContextMenu() {
  el.contextMenu.style.display = "none";
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});

// ── Export ───────────────────────────────────────────────────────────────────

function showProgress(title) {
  el.progressTitle.textContent = title;
  el.progressBar.style.width = "0%";
  el.progressDetail.textContent = "";
  el.progressOverlay.style.display = "flex";
}

function updateProgress(pct, detail) {
  el.progressBar.style.width = Math.round(pct) + "%";
  if (detail) el.progressDetail.textContent = detail;
}

function hideProgress() {
  el.progressOverlay.style.display = "none";
}

function archivePathFor(item, sections) {
  if (sections.size > 1) return item.section + "/" + item.path;
  return item.path;
}

async function exportItems(items, archiveName) {
  const format = el.formatSelect.value;
  showProgress(`Building ${format.toUpperCase()} archive...`);

  const rawItems = items.filter((it) => it.section === "raw");
  const requestItems = items.filter((it) => it.section === "requests");
  if (rawItems.length) await ensureRawContent(rawItems);
  if (requestItems.length) await ensureRequestResponses(requestItems);

  const applyPretty = prefs.prettyOnExport;
  let prettyFailed = 0;
  let prettyApplied = 0;
  const sections = new Set(items.map((item) => item.section));

  const files = items
    .map((it) => {
      const tree = treeFor(it.section);
      const entry = tree[it.path];
      if (!entry) return null;
      const archivePath = archivePathFor(it, sections);
      if (entry.content == null) {
        return { path: archivePath, content: makePlaceholder(it.path, entry), placeholder: true };
      }
      let content = entry.content;
      if (applyPretty) {
        const lang = detectEntryLang(it.path, entry);
        if (canPrettyFormat(lang)) {
          const r = tryPretty(content, lang);
          if (r.ok) {
            content = r.content;
            prettyApplied++;
          } else {
            prettyFailed++;
            const header = commentHeader(lang, [
              "Source Exporter: pretty-format failed for this file.",
              "Reason: " + r.reason,
              "Falling back to original (un-formatted) content.",
            ]);
            if (header) content = header + content;
          }
        }
      }
      return { path: archivePath, content, placeholder: false };
    })
    .filter(Boolean);

  if (files.length === 0) {
    hideProgress();
    alert("No exportable files.");
    return;
  }

  const placeholderCount = files.filter((f) => f.placeholder).length;

  if (format === "zip") {
    await exportZip(files, archiveName);
  } else {
    await exportTar(files, archiveName);
  }

  hideProgress();

  const notes = [];
  if (placeholderCount > 0) {
    notes.push(
      `${placeholderCount} placeholder${placeholderCount !== 1 ? "s" : ""} (content unavailable)`
    );
  }
  if (applyPretty) {
    notes.push(`pretty-formatted ${prettyApplied}`);
    if (prettyFailed > 0) notes.push(`${prettyFailed} fell back to original`);
  }
  if (notes.length) {
    setStatus("active", "Exported — " + notes.join(", "));
  }
}

function makePlaceholder(path, entry) {
  const url = entry.sourceURL || entry.scriptURL || "(unknown)";
  const reason =
    entry.fetchStatus === "missing"
      ? "Failed to fetch original content."
      : "Original content was not available (no embedded source content and no successful fetch).";
  return [
    "// Source Exporter placeholder",
    `// Path: ${path}`,
    `// URL:  ${url}`,
    `// ${reason}`,
    "// This file is a placeholder — the original content could not be retrieved.",
    "",
  ].join("\n");
}

async function exportZip(files, name) {
  const zip = new JSZip();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 90, f.path);
    zip.file(f.path, f.content);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  updateProgress(95, "Compressing...");
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => updateProgress(95 + meta.percent * 0.05, "Compressing...")
  );

  updateProgress(100, "Done");
  triggerDownload(blob, `${name}.zip`);
}

async function exportTar(files, name) {
  const chunks = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    updateProgress((i / files.length) * 95, f.path);

    const encoded = new TextEncoder().encode(f.content);
    chunks.push(makeTarHeader(f.path, encoded.length));
    chunks.push(paddedBlock(encoded));

    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  chunks.push(new Uint8Array(1024));

  updateProgress(100, "Done");
  const blob = new Blob(chunks, { type: "application/x-tar" });
  triggerDownload(blob, `${name}.tar`);
}

function paddedBlock(data) {
  const remainder = data.length % 512;
  if (remainder === 0) return data;
  const padded = new Uint8Array(data.length + (512 - remainder));
  padded.set(data);
  return padded;
}

function splitUstarPath(p) {
  if (p.length <= 100) return { name: p, prefix: "" };
  for (let i = Math.max(0, p.length - 100); i < p.length - 1; i++) {
    if (p[i] === "/") {
      const prefix = p.slice(0, i);
      const name = p.slice(i + 1);
      if (prefix.length <= 155 && name.length <= 100 && name.length > 0) {
        return { name, prefix };
      }
    }
  }
  return { name: p.slice(-100), prefix: "" };
}

function makeTarHeader(filePath, fileSize) {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();

  function write(offset, str, maxLen) {
    const bytes = enc.encode(str.slice(0, maxLen));
    header.set(bytes, offset);
  }

  const { name, prefix } = splitUstarPath(filePath);
  write(0, name, 100);
  write(100, "0000644\0", 8);
  write(108, "0000000\0", 8);
  write(116, "0000000\0", 8);
  write(124, fileSize.toString(8).padStart(11, "0") + "\0", 12);
  write(
    136,
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    12
  );
  header[156] = 0x30;
  write(257, "ustar\0", 6);
  write(263, "00", 2);
  if (prefix) write(345, prefix, 155);

  header.fill(0x20, 148, 156);
  let cksum = 0;
  for (const b of header) cksum += b;
  write(148, cksum.toString(8).padStart(6, "0") + "\0 ", 8);

  return header;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Item selectors ───────────────────────────────────────────────────────────

function getAllItems() {
  return ALL_SECTIONS.flatMap((section) => getAllItemsInSection(section));
}

function getItemsInSection(section) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((path) =>
      section === "requests"
        ? requestMatchesFilters(path, tree[path])
        : locationFilterMatches(tree[path])
    )
    .map((path) => ({ path, section }));
}

function getAllItemsInSection(section) {
  return Object.keys(treeFor(section)).map((path) => ({ path, section }));
}

function archiveNameForSection(section) {
  const suffix = section === "mapped" ? "authored" : section === "raw" ? "deployed" : "requests";
  return `${getDomainLabel()}-${suffix}`;
}

function getItemsUnderDir(section, dirPath, domain) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((p) => {
      const entry = tree[p];
      if (dirPath && p !== dirPath && !p.startsWith(dirPath + "/")) return false;
      if (domain && domainOf(entry) !== domain) return false;
      return locationFilterMatches(entry);
    })
    .map((path) => ({ path, section }));
}

function getDomainLabel() {
  try {
    for (const section of ALL_SECTIONS) {
      const tree = treeFor(section);
      const urls = Object.values(tree)
        .map((e) => e.scriptURL || e.sourceURL)
        .filter(Boolean);
      if (urls.length === 0) continue;
      const u = new URL(urls[0]);
      return u.hostname.replace(/^www\./, "");
    }
    return "sources";
  } catch {
    return "sources";
  }
}

async function ensureRawContent(items) {
  const missing = items.filter((it) => {
    const tree = treeFor(it.section);
    const e = tree[it.path];
    return (
      e &&
      e.content == null &&
      e.fetchStatus !== "missing" &&
      e.sourceURL &&
      !e.sourceURL.startsWith("data:")
    );
  });
  for (let i = 0; i < missing.length; i++) {
    const it = missing[i];
    const tree = treeFor(it.section);
    updateProgress((i / missing.length) * 30, `Fetching ${it.path}`);
    const c = await loadRawByURL(tree[it.path].sourceURL, tree[it.path]._resource);
    if (c != null) {
      tree[it.path].content = c;
      tree[it.path].fetchStatus = "ok";
    } else {
      tree[it.path].fetchStatus = "missing";
    }
  }
}

async function ensureRequestResponses(items) {
  const pending = items
    .map(({ path }) => state.requestTree[path])
    .filter((entry) => entry?._responseStatus === "idle" && canLoadResponseBody(entry));
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    updateProgress((i / pending.length) * 30, `Fetching ${entry._record.request.url}`);
    await loadRequestResponse(entry);
  }
}

// ── Wire UI ──────────────────────────────────────────────────────────────────

el.ctxExportFile.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "file") {
    const { path, section } = state.contextTarget;
    exportItems([{ path, section }], path.split("/").pop());
  }
});

el.ctxExportDir.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "dir") {
    const { path, section, domain } = state.contextTarget;
    const items = getItemsUnderDir(section, path, domain);
    const label = path.split("/").pop() || domain || getDomainLabel();
    exportItems(items, label);
  }
});

el.ctxExportSection.addEventListener("click", () => {
  hideContextMenu();
  if (state.contextTarget && state.contextTarget.type === "section") {
    const { section } = state.contextTarget;
    exportItems(getItemsInSection(section), archiveNameForSection(section));
  }
});

// A folder's subtree is its path (plus its domain, for grouped Authored files);
// a section header means the whole section.
function foldBase(target) {
  return target.type === "dir" ? target.path : "";
}

function foldDomain(target) {
  return target.type === "dir" ? target.domain : undefined;
}

el.ctxCollapseAll.addEventListener("click", () => {
  hideContextMenu();
  const target = state.contextTarget;
  if (target) setTreeFoldState(target.section, foldBase(target), false, foldDomain(target));
});

el.ctxExpandAll.addEventListener("click", () => {
  hideContextMenu();
  const target = state.contextTarget;
  if (target) setTreeFoldState(target.section, foldBase(target), true, foldDomain(target));
});

el.ctxCopyPath.addEventListener("click", async () => {
  hideContextMenu();
  const target = state.contextTarget;
  const text = target?.path || target?.domain;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard unavailable in some DevTools contexts
  }
});

el.ctxExportAll.addEventListener("click", () => {
  hideContextMenu();
  exportItems(getAllItems(), getDomainLabel());
});

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
