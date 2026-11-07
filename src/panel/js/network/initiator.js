// Request initiator: renders the snapshot kept in `entry._initiator` (type, location and the
// sync/async call stack) for the Initiator tab and opens its frames in the editor. Classic
// script defining the RequestInitiator global. Uses request-detail.js (requestDetailSection,
// requestDetailEmpty), tabs-preview.js (openFile, loadRawByURL), search.js (position helpers),
// filetype.js and discovery.js (mapGeneratedPosition) at call time only.
//
// Positions are zero-based everywhere here, as in the HAR snapshot and the source map lookup.
// They become editor (one-based) coordinates exactly once, in editorPosition().
"use strict";

const RequestInitiator = (() => {
  const DEVTOOLS_URL = /^(?:https?|file):/i;
  const DEVTOOLS_OPEN_TIMEOUT_MS = 3000;
  const TYPE_LABELS = {
    parser: "Parser",
    script: "Script",
    preload: "Preload",
    preflight: "Preflight",
    other: "Other",
    SignedExchange: "Signed exchange",
  };
  const MAP_NOTES = {
    unmapped: "source map has no mapping for this position",
    "source-missing": "mapped source was not captured",
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function displayNumber(zeroBased) {
    return String(zeroBased + 1);
  }

  function positionSuffix(line, column) {
    if (line == null) return "";
    return column == null
      ? `:${displayNumber(line)}`
      : `:${displayNumber(line)}:${displayNumber(column)}`;
  }

  function shortUrl(url) {
    if (/^(?:data|blob|javascript):/i.test(url)) return url.slice(0, 40);
    try {
      const parsed = new URL(url);
      return parsed.pathname.split("/").filter(Boolean).pop() || parsed.host || url;
    } catch {
      return url;
    }
  }

  function generatedLabel(location) {
    return shortUrl(location.url) + positionSuffix(location.lineNumber, location.columnNumber);
  }

  // The one predicate deciding whether a location still belongs to the current capture: the
  // scan generation must match, and when both times are known the request must not have
  // started before the current page loaded (1 ms tolerates ISO millisecond rounding). That
  // catches an old-page request that finished after onNavigated and got the new generation.
  // Unknown times fall back to the generation check alone.
  function isCurrentLocation({ generation, startedAt }) {
    if (generation !== state.scanGeneration) return false;
    if (Number.isFinite(startedAt) && Number.isFinite(state.scanPageId)) {
      return startedAt >= state.scanPageId - 1;
    }
    return true;
  }

  // Where a location can be opened, decided from captured data only. In order: the authored
  // file retained source map mappings lead to, the captured raw script at the generated
  // position, DevTools itself (external), nothing. `location.generation` is the scan
  // generation the request was captured in; the maps and scripts held now describe the
  // current capture, so a location from any other (or no) generation is never resolved.
  function resolve(location) {
    const { url, lineNumber: line, columnNumber: column } = location;
    if (!url) return { kind: "none", reason: "No script URL (native or eval code)" };
    if (!isCurrentLocation(location)) {
      return {
        kind: "none",
        reason:
          "The capture changed since this request (navigation or reset), so the original script and source map are not available",
      };
    }

    let mapStatus = null;
    if (line != null && column != null) {
      const mapped = mapGeneratedPosition(url, line, column);
      if (mapped.status === "mapped") {
        return {
          kind: "mapped",
          section: "mapped",
          path: mapped.path,
          line: mapped.line,
          column: mapped.column,
        };
      }
      mapStatus = mapped.status;
    }

    const raw = state.rawByURL.get(url);
    if (raw && treeFor(raw.section)[raw.path]) {
      return { kind: "raw", section: raw.section, path: raw.path, line, column, mapStatus };
    }
    if (DEVTOOLS_URL.test(url)) return { kind: "devtools", url, line, column };
    return { kind: "none", reason: "Script was not captured and cannot be opened by URL" };
  }

  // The single zero-based -> editor (one-based) conversion. When the editor shows the
  // pretty-formatted text, the position is carried over to it like a search hit is.
  function editorPosition(path, entry, line, column) {
    if (line == null) return undefined;
    const position = { line: line + 1, column: (column ?? 0) + 1 };
    position.endColumn = position.column;
    if (!state.prettyView || typeof entry.content !== "string") return position;

    const lang = detectEntryLang(path, entry);
    if (!canPrettyFormat(lang)) return position;
    const pretty = tryPretty(entry.content, lang);
    if (!pretty.ok) return position;
    const offset = offsetForLineColumn(entry.content, position.line, position.column);
    const shown = positionForOffset(
      pretty.content,
      mapOffsetIgnoringWhitespace(entry.content, pretty.content, offset)
    );
    return {
      line: shown.line,
      column: shown.column,
      endColumn: shown.column,
      formattedContent: pretty.content,
    };
  }

  // Loads the file text the way selectFile does, so the position can be computed against it.
  // A failed load is left for selectFile to report.
  async function loadEntryContent(entry) {
    if (entry.content != null || entry.fetchStatus === "missing") return;
    if (!entry.sourceURL || entry.sourceURL.startsWith("data:")) return;
    const fetched = await loadRawByURL(entry.sourceURL, entry._resource);
    if (fetched != null && entry.content == null) {
      entry.content = fetched;
      entry.fetchStatus = "ok";
    }
  }

  async function openCaptured(target, location) {
    const entry = treeFor(target.section)[target.path];
    if (!entry) return "The captured file is no longer available.";
    await loadEntryContent(entry);
    if (!isCurrentLocation(location)) {
      return "The capture changed while loading, so the location was not opened.";
    }
    if (treeFor(target.section)[target.path] !== entry) {
      return "The captured file is no longer available.";
    }
    openFile(
      target.path,
      target.section,
      editorPosition(target.path, entry, target.line, target.column)
    );

    const edited = entry.edited ? " The file was edited, so the position may have moved." : "";
    if (target.kind === "mapped") {
      const authored = target.path + positionSuffix(target.line, target.column);
      return `Opened ${authored} (mapped from ${generatedLabel(location)}).${edited}`;
    }
    const where =
      target.line == null
        ? ""
        : ` at generated ${positionSuffix(target.line, target.column).slice(1)}`;
    return `Opened captured script ${target.path}${where}.${edited}`;
  }

  // DevTools takes zero-based positions here: ExtensionServer.onOpenResource passes them
  // unchanged to uiSourceCode.uiLocation(). It leaves this panel, hence the explicit status.
  function openInDevTools(target) {
    const opened = new Promise((resolveOpen) => {
      const done = (response) =>
        resolveOpen(
          response?.isError
            ? `DevTools could not open ${target.url}.`
            : `Opened ${target.url} in DevTools (outside DevTools++).`
        );
      const line = target.line ?? 0;
      const column = target.column ?? 0;
      try {
        chrome.devtools.panels.openResource(target.url, line, column, done);
      } catch {
        // Older Chrome rejects the column argument.
        try {
          chrome.devtools.panels.openResource(target.url, line, done);
        } catch (error) {
          resolveOpen(`DevTools could not open ${target.url}: ${error.message}`);
        }
      }
    });
    return withTimeout(
      opened,
      DEVTOOLS_OPEN_TIMEOUT_MS,
      `Asked DevTools to open ${target.url} (outside DevTools++).`
    );
  }

  // Opens a location; resolves to a one-line status message.
  async function open(location) {
    const target = resolve(location);
    if (target.kind === "none") return `Cannot open: ${target.reason}.`;
    if (target.kind === "devtools") return openInDevTools(target);
    return openCaptured(target, location);
  }

  function locationNote(target, location) {
    if (target.kind === "mapped") return `generated ${generatedLabel(location)}`;
    if (target.kind === "devtools") return "opens in DevTools";
    if (target.kind === "raw") return MAP_NOTES[target.mapStatus] || "";
    return "";
  }

  // A clickable location (or plain text when it cannot be opened). Frames are
  // untrusted page data: every label is set through textContent.
  function locationControl(location, status) {
    const holder = node("span", "initiator-location");
    const target = resolve(location);
    const generated = generatedLabel(location);
    if (target.kind === "none") {
      const text = node("span", "initiator-unavailable", location.url ? generated : "(unknown)");
      text.title = target.reason;
      holder.appendChild(text);
      return holder;
    }

    const authored =
      target.kind === "mapped" ? target.path + positionSuffix(target.line, target.column) : null;
    const button = node("button", "initiator-frame-link", authored ?? generated);
    button.type = "button";
    button.dataset.targetKind = target.kind;
    button.title = `${location.url}${positionSuffix(location.lineNumber, location.columnNumber)}`;
    button.setAttribute("aria-label", `Open ${authored ?? generated}`);
    button.addEventListener("click", async () => {
      status.textContent = "Opening...";
      try {
        status.textContent = await open(location);
      } catch (error) {
        status.textContent = `Cannot open: ${error.message}.`;
      }
    });
    holder.appendChild(button);

    const note = locationNote(target, location);
    if (note) holder.appendChild(node("span", "initiator-note", note));
    return holder;
  }

  function kvTable(rows) {
    const table = node("div", "kv-table");
    table.style.setProperty("--kv-key-chars", "10");
    for (const [name, value] of rows) {
      const row = node("div", "kv-row");
      const key = node("span", "kv-key");
      key.append(name, node("span", "kv-colon", ":"));
      const cell = node("span", "kv-value");
      cell.append(value);
      row.append(key, cell);
      table.appendChild(row);
    }
    return table;
  }

  function renderFrames(stack, status, context) {
    const list = node("ol", "initiator-frames");
    list.setAttribute("aria-label", "Call stack");
    let first = true;
    for (let current = stack; current; current = current.parent) {
      if (!first) {
        const boundary = node("li", "initiator-boundary");
        boundary.textContent = current.description ? `Async: ${current.description}` : "Async";
        list.appendChild(boundary);
      }
      first = false;
      if (!current.frames.length) {
        list.appendChild(node("li", "initiator-frame initiator-frame-empty", "(no frames)"));
      }
      for (const frame of current.frames) {
        const item = node("li", "initiator-frame");
        item.appendChild(node("span", "initiator-func", frame.functionName || "(anonymous)"));
        item.appendChild(locationControl({ ...frame, ...context }, status));
        list.appendChild(item);
      }
      if (current.parentMissing) {
        list.appendChild(node("li", "initiator-boundary", "Async parent not captured"));
      }
    }
    return list;
  }

  function render(entry) {
    const root = node("div", "request-initiator");
    const status = node("p", "request-initiator-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    root.appendChild(status);

    const initiator = entry?._initiator;
    if (!initiator) {
      root.appendChild(
        requestDetailEmpty("Initiator unavailable: DevTools did not report one for this request.")
      );
      return root;
    }

    // Carried by every location so resolve() and open() judge the request they came from.
    const context = {
      generation: entry._initiatorGeneration,
      startedAt: Date.parse(entry._record?.capturedAt),
    };
    const rows = [["Type", TYPE_LABELS[initiator.type] || initiator.type || "Unknown"]];
    if (initiator.url) {
      const where = {
        url: initiator.url,
        lineNumber: initiator.lineNumber,
        columnNumber: initiator.columnNumber,
        ...context,
      };
      rows.push(["Location", locationControl(where, status)]);
    }
    if (initiator.truncated) rows.push(["Note", "The call stack was cut at the capture limit."]);
    if (!isCurrentLocation(context)) {
      rows.push([
        "Note",
        "Locations cannot be opened: the capture changed since this request (navigation or reset), so the original script and source map are not available.",
      ]);
    }
    root.appendChild(requestDetailSection("Initiator", kvTable(rows)));

    const stack = initiator.stack
      ? renderFrames(initiator.stack, status, context)
      : requestDetailEmpty("No call stack was reported for this request.");
    root.appendChild(requestDetailSection("Call stack", stack));
    return root;
  }

  // Shows the Initiator tab of a captured request (context menu entry point).
  function show(path) {
    if (!state.requestTree[path]) return false;
    state.requestDetailTab = "initiator";
    openFile(path, "requests");
    return true;
  }

  return { render, show, resolve, open };
})();
