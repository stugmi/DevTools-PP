// ZIP/TAR export, progress reporting and selectors for captured files and requests.
// Loaded after tabs-preview.js and before context-menu.js.
"use strict";

// -- Export --

// Percent ranges of an export: fetch 0-20, format 20-40, archive 40-100.
const PROGRESS_FETCH_END = 20;
const PROGRESS_FORMAT_END = 40;
const EXPORT_FETCH_CONCURRENCY = 6;

let exporting = false;
let progressReturnFocus = null;

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

function showProgress(title) {
  el.progressTitle.textContent = title;
  el.progressBar.style.width = "0%";
  el.progressBar.parentElement.setAttribute("aria-valuenow", "0");
  el.progressDetail.textContent = "";
  el.progressOverlay.style.display = "flex";
  progressReturnFocus = document.activeElement;
  el.progressOverlay.focus();
}

function updateProgress(pct, detail) {
  const rounded = Math.round(pct);
  el.progressBar.style.width = rounded + "%";
  el.progressBar.parentElement.setAttribute("aria-valuenow", String(rounded));
  if (detail) el.progressDetail.textContent = detail;
}

// Maps 0-1 within the archive phase onto the overall bar.
function archiveProgress(fraction, detail) {
  updateProgress(PROGRESS_FORMAT_END + fraction * (100 - PROGRESS_FORMAT_END), detail);
}

function hideProgress() {
  el.progressOverlay.style.display = "none";
  if (progressReturnFocus?.isConnected) progressReturnFocus.focus();
  progressReturnFocus = null;
}

function archivePathFor(item, sections) {
  if (sections.size > 1) return item.section + "/" + item.path;
  return item.path;
}

async function exportItems(items, archiveName) {
  if (exporting) return;
  exporting = true;
  const format = el.formatSelect.value;
  showProgress(`Building ${format.toUpperCase()} archive...`);

  try {
    const rawItems = items.filter((it) => it.section === "raw" || it.section === "mapped");
    const requestItems = items.filter((it) => it.section === "requests");
    const both = rawItems.length > 0 && requestItems.length > 0;
    const rawEnd = both ? PROGRESS_FETCH_END / 2 : PROGRESS_FETCH_END;
    if (rawItems.length) await ensureRawContent(rawItems, 0, rawEnd);
    if (requestItems.length) {
      await ensureRequestResponses(requestItems, both ? rawEnd : 0, PROGRESS_FETCH_END);
    }

    const applyPretty = prefs.prettyOnExport;
    let prettyFailed = 0;
    let prettyApplied = 0;
    const sections = new Set(items.map((item) => item.section));

    const files = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i % (applyPretty ? 5 : 200) === 0) {
        const fraction = i / items.length;
        updateProgress(
          PROGRESS_FETCH_END + fraction * (PROGRESS_FORMAT_END - PROGRESS_FETCH_END),
          applyPretty ? `Formatting ${it.path}` : "Preparing files..."
        );
        await yieldToUI();
      }
      const entry = treeFor(it.section)[it.path];
      if (!entry) continue;
      const archivePath = archivePathFor(it, sections);
      if (entry.content == null) {
        files.push({
          path: archivePath,
          content: makePlaceholder(it.path, entry),
          placeholder: true,
        });
        continue;
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
      files.push({ path: archivePath, content, placeholder: false });
    }

    if (files.length === 0) {
      setStatus("No exportable files.", { error: true });
      return;
    }

    const placeholderCount = files.filter((f) => f.placeholder).length;

    updateProgress(PROGRESS_FORMAT_END, "Building archive...");
    if (format === "zip") {
      await exportZip(files, archiveName);
    } else {
      await exportTar(files, archiveName);
    }

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
      setStatus("Exported — " + notes.join(", "));
    }
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, { error: true });
  } finally {
    exporting = false;
    hideProgress();
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
    archiveProgress((i / files.length) * 0.1, f.path);
    zip.file(f.path, f.content);
    if (i % 20 === 0) await yieldToUI();
  }

  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => archiveProgress(0.1 + meta.percent * 0.009, "Compressing...")
  );

  updateProgress(100, "Done");
  triggerDownload(blob, `${name}.zip`);
}

async function exportTar(files, name) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);
  // Appends file data padded to a whole 512-byte block.
  const pushData = (data) => {
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder) chunks.push(new Uint8Array(512 - remainder));
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    archiveProgress(i / files.length, f.path);

    const data = tarEncoder.encode(f.content);
    let split = splitUstarPath(tarEncoder.encode(f.path));
    if (!split) {
      // Does not fit name/prefix: a PAX header carries the real path, and the ustar
      // entry gets an ASCII stand-in name.
      const pax = paxRecord("path", f.path);
      const stand = tarEncoder.encode(asciiTarName(f.path, 100));
      chunks.push(
        makeTarHeader(
          { name: tarEncoder.encode("PaxHeader/" + asciiTarName(f.path, 80)), prefix: null },
          pax.length,
          "x",
          mtime
        )
      );
      pushData(pax);
      split = { name: stand, prefix: null };
    }
    chunks.push(makeTarHeader(split, data.length, "0", mtime));
    pushData(data);

    if (i % 20 === 0) await yieldToUI();
  }

  chunks.push(new Uint8Array(1024));

  updateProgress(100, "Done");
  const blob = new Blob(chunks, { type: "application/x-tar" });
  triggerDownload(blob, `${name}.tar`);
}

const tarEncoder = new TextEncoder();
const tarDecoder = new TextDecoder();

// Printable stand-in for a path's last segment, at most `max` bytes.
function asciiTarName(path, max) {
  return (
    path
      .split("/")
      .pop()
      .replace(/[^\w.-]/g, "_")
      .slice(-max) || "file"
  );
}

// One PAX extended-header record ("<len> key=value\n"); <len> counts the whole record.
function paxRecord(key, value) {
  const body = tarEncoder.encode(` ${key}=${value}\n`);
  let len = body.length;
  let prev;
  do {
    prev = len;
    len = body.length + String(prev).length;
  } while (len !== prev);
  const record = new Uint8Array(len);
  record.set(tarEncoder.encode(String(len)));
  record.set(body, len - body.length);
  return record;
}

// Splits UTF-8 path bytes at a "/" into ustar name (<= 100 bytes) and prefix (<= 155 bytes).
// Returns null when no split fits (the caller then uses a PAX header).
function splitUstarPath(bytes) {
  if (bytes.length <= 100) return { name: bytes, prefix: null };
  for (let i = Math.max(0, bytes.length - 101); i < bytes.length - 1 && i <= 155; i++) {
    if (bytes[i] === 0x2f) {
      return { name: bytes.subarray(i + 1), prefix: bytes.subarray(0, i) };
    }
  }
  return null;
}

// `split` holds name/prefix as UTF-8 bytes; `type` is the ustar typeflag ("0" file, "x" PAX).
function makeTarHeader(split, fileSize, type, mtime) {
  const header = new Uint8Array(512);

  function write(offset, value, maxLen) {
    const bytes = typeof value === "string" ? tarEncoder.encode(value) : value;
    if (bytes.length > maxLen) {
      const shown = typeof value === "string" ? value : tarDecoder.decode(value);
      throw new Error("tar field overflow: " + shown);
    }
    header.set(bytes, offset);
  }

  write(0, split.name, 100);
  write(100, "0000644\0", 8);
  write(108, "0000000\0", 8);
  write(116, "0000000\0", 8);
  write(124, fileSize.toString(8).padStart(11, "0") + "\0", 12);
  write(136, mtime.toString(8).padStart(11, "0") + "\0", 12);
  header[156] = type.charCodeAt(0);
  write(257, "ustar\0", 6);
  write(263, "00", 2);
  if (split.prefix) write(345, split.prefix, 155);

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

// -- Item selectors --

function getAllItems() {
  return ALL_SECTIONS.flatMap((section) => getAllItemsInSection(section));
}

function getItemsInSection(section) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((path) =>
      section === "requests"
        ? requestMatchesFilters(path, tree[path])
        : sourceFilterMatches(section, path, tree[path])
    )
    .map((path) => ({ path, section }));
}

function getAllItemsInSection(section) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((path) => sourceFilterMatches(section, path, tree[path]))
    .map((path) => ({ path, section }));
}

function archiveNameForSection(section) {
  const suffix = section === "mapped" ? "authored" : section === "raw" ? "deployed" : "requests";
  return `${getDomainLabel()}-${suffix}`;
}

function getItemsUnderDir(section, dirPath, group) {
  const tree = treeFor(section);
  return Object.keys(tree)
    .filter((p) => {
      const entry = tree[p];
      if (dirPath && p !== dirPath && !p.startsWith(dirPath + "/")) return false;
      if (group && groupOf(section, p, entry) !== group) return false;
      return sourceFilterMatches(section, p, entry);
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

async function ensureRawContent(items, from, to) {
  const entries = items.map((it) => treeFor(it.section)[it.path]);
  await ensureContent(entries, {
    concurrency: EXPORT_FETCH_CONCURRENCY,
    onProgress: (done, total) =>
      updateProgress(from + ((to - from) * done) / total, `Fetching ${done}/${total}`),
  });
}

async function ensureRequestResponses(items, from, to) {
  const pending = items
    .map(({ path }) => state.requestTree[path])
    .filter(
      (entry) =>
        (entry?._responseStatus === "idle" || entry?._responseStatus === "loading") &&
        canLoadResponseBody(entry)
    );
  let done = 0;
  await runLimited(pending, EXPORT_FETCH_CONCURRENCY, async (entry) => {
    await loadRequestResponse(entry);
    const fraction = ++done / pending.length;
    updateProgress(from + (to - from) * fraction, `Fetching ${done}/${pending.length}`);
  });
  // The selected request may have been waiting on one of these loads.
  if (pending.length) rerenderSelectedRequest();
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(+n) || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
