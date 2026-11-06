// Hex viewer for the Network Payload/Response tabs: a virtualized hex grid with an ASCII column,
// byte selection, a Data Inspector, Go to / Find / Copy tools and a status bar. Classic script
// defining the global `HexViewer`; uses HexInspector (lib/hex-inspector.js) and
// copyTextToClipboard (network/cookies.js). Captured bytes only ever reach the DOM through
// textContent, never as HTML. Loaded before request-detail.js, which mounts one viewer per host.

"use strict";

const HexViewer = (() => {
  const COLS = 16;
  const ROW_H = 20;
  const HEADER_H = 22;
  const BUFFER_ROWS = 6;
  // Below this width the Data Inspector starts collapsed (the grid alone needs about 590px).
  const NARROW_PX = 720;
  // Largest scroll height used; browsers clamp element heights near 33M px.
  const MAX_SPACER_PX = 8_000_000;

  const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
  const ASCII = Array.from({ length: 256 }, (_, byte) =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."
  );

  // Byte kinds drive the cell colors: z = 0x00, p = printable, w = whitespace, c = other control,
  // x = high (0x80+).
  function kindOf(byte) {
    if (byte === 0) return "z";
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) return "w";
    if (byte < 0x20 || byte === 0x7f) return "c";
    return byte >= 0x80 ? "x" : "p";
  }
  const HEX_CLASS = HEX.map((_, byte) => `hexv-b hexv-h k-${kindOf(byte)}`);
  const ASCII_CLASS = HEX.map((_, byte) => `hexv-b hexv-a k-${kindOf(byte)}`);
  const PAD_HEX = "hexv-b hexv-h pad";
  const PAD_ASCII = "hexv-b hexv-a pad";

  const COPY_FORMATS = [
    ["hex", "Hex"],
    ["hex-compact", "Hex (compact)"],
    ["c", "C array"],
    ["python", "Python bytes"],
    ["base64", "Base64"],
    ["ascii", "ASCII text"],
  ];

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeButton(className, text, title) {
    const button = make("button", className, text);
    button.type = "button";
    if (title) {
      button.title = title;
      button.setAttribute("aria-label", title);
    }
    return button;
  }

  const hex = (value) => value.toString(16);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  function mount(host) {
    let bytes = null;
    let length = 0;
    let rowCount = 0;
    let note = "";
    let anchor = -1; // selection anchor; -1 = nothing selected
    let head = -1; // selection cursor (the end that moves)
    let hover = -1;
    let match = null; // { start, end } of the last Find hit, end exclusive
    let littleEndian = true;
    let version = 0; // bumped whenever cell appearance may have changed
    let dragging = false;
    let frame = 0;
    let narrow = null;
    let inspectorOpen = true;
    let messageTimer = 0;
    let destroyed = false;
    const pool = [];
    let totalPx = 0; // full height of the body in rows * ROW_H
    let scaled = false; // true when totalPx exceeds MAX_SPACER_PX
    let vTop = 0;
    let vTopScroll = 0;

    // -- DOM --

    const root = make("div", "hexv");

    const toolbar = make("div", "hexv-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Hex viewer tools");

    const gotoInput = make("input", "hexv-input hexv-goto");
    gotoInput.type = "text";
    gotoInput.placeholder = "Go to offset";
    gotoInput.title = "Go to offset: 0x40000 or 262144 (Ctrl+G)";
    gotoInput.setAttribute("aria-label", "Go to offset, hexadecimal 0x prefix or decimal");
    gotoInput.spellcheck = false;
    const gotoButton = makeButton("hexv-btn", "Go", "Go to offset");

    const findInput = make("input", "hexv-input hexv-find");
    findInput.type = "text";
    findInput.placeholder = "Find bytes or text";
    findInput.title = "Find (Enter: next, Shift+Enter: previous, Ctrl+F)";
    findInput.setAttribute("aria-label", "Find in body");
    findInput.spellcheck = false;
    const findMode = make("select", "hexv-select");
    findMode.setAttribute("aria-label", "Find mode");
    findMode.append(new Option("Hex", "hex"), new Option("Text", "text"));
    const findPrev = makeButton("hexv-btn", "\u2039", "Previous match (Shift+Enter)");
    const findNext = makeButton("hexv-btn", "\u203a", "Next match (Enter)");

    const spacerFlex = make("span", "hexv-flex");
    const copyButton = makeButton("hexv-btn", "Copy \u25be", "Copy selection as...");
    copyButton.setAttribute("aria-haspopup", "menu");
    copyButton.setAttribute("aria-expanded", "false");
    const inspectorButton = makeButton("hexv-btn", "Inspector", "Show or hide the Data Inspector");
    inspectorButton.setAttribute("aria-pressed", "true");
    toolbar.append(
      gotoInput,
      gotoButton,
      findInput,
      findMode,
      findPrev,
      findNext,
      spacerFlex,
      copyButton,
      inspectorButton
    );

    const main = make("div", "hexv-main");
    const scroller = make("div", "hexv-scroll");
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "application");

    const header = make("div", "hexv-head");
    header.setAttribute("aria-hidden", "true");
    header.append(make("span", "hexv-addr", "Offset"));
    const headHex = make("span", "hexv-hex");
    for (let col = 0; col < COLS; col++) {
      headHex.append(make("span", "hexv-b hexv-h hexv-colhead", HEX[col].toUpperCase()));
    }
    header.append(headHex, make("span", "hexv-asc hexv-asciihead", "Decoded text"));

    const spacer = make("div", "hexv-spacer");
    const layer = make("div", "hexv-rows");
    spacer.append(layer);
    scroller.append(header, spacer);

    const inspector = make("aside", "hexv-inspector");
    inspector.setAttribute("aria-label", "Data Inspector");
    const inspectorHead = make("div", "hexv-ihead");
    const endianGroup = make("span", "hexv-endian");
    endianGroup.setAttribute("role", "group");
    endianGroup.setAttribute("aria-label", "Byte order");
    const leButton = makeButton("hexv-btn", "LE", "Little endian");
    const beButton = makeButton("hexv-btn", "BE", "Big endian");
    endianGroup.append(leButton, beButton);
    inspectorHead.append(make("span", "hexv-ititle", "Data Inspector"), endianGroup);
    const inspectorOffset = make("div", "hexv-ioffset");
    const inspectorList = make("div", "hexv-ilist");
    inspector.append(inspectorHead, inspectorOffset, inspectorList);
    main.append(scroller, inspector);

    const status = make("div", "hexv-status");
    const statusSelection = make("span", "hexv-st-sel");
    statusSelection.setAttribute("role", "status");
    statusSelection.setAttribute("aria-live", "polite");
    const statusTotal = make("span", "hexv-st-total");
    const statusNote = make("span", "hexv-st-note");
    const statusMessage = make("span", "hexv-st-msg");
    statusMessage.setAttribute("role", "status");
    statusMessage.setAttribute("aria-live", "polite");
    status.append(statusSelection, statusTotal, statusNote, statusMessage);

    const menu = make("div", "hexv-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Copy selection as");
    const menuItems = [];
    for (const [format, label] of COPY_FORMATS) {
      const item = makeButton("hexv-menuitem", label);
      item.setAttribute("role", "menuitem");
      item.dataset.format = format;
      menuItems.push(item);
      menu.append(item);
    }
    menu.append(make("div", "hexv-menusep"));
    const copyAllItem = makeButton("hexv-menuitem", "Copy entire body (hex)");
    copyAllItem.setAttribute("role", "menuitem");
    copyAllItem.dataset.action = "all";
    const selectAllItem = makeButton("hexv-menuitem", "Select all (Ctrl+A)");
    selectAllItem.setAttribute("role", "menuitem");
    selectAllItem.dataset.action = "select-all";
    menu.append(copyAllItem, selectAllItem);

    root.append(toolbar, main, status, menu);
    host.append(root);

    // -- Selection model --

    function selRange() {
      if (anchor < 0 || head < 0) return null;
      return { lo: Math.min(anchor, head), hi: Math.max(anchor, head) };
    }

    // -- Message line --

    function message(text, ms = 4000) {
      statusMessage.textContent = text;
      clearTimeout(messageTimer);
      if (text && ms) {
        messageTimer = setTimeout(() => {
          statusMessage.textContent = "";
        }, ms);
      }
    }

    // -- Virtualized rendering --

    function createRow() {
      const row = make("div", "hexv-row");
      const addr = make("span", "hexv-addr");
      const hexGroup = make("span", "hexv-hex");
      const asciiGroup = make("span", "hexv-asc");
      row._addrText = document.createTextNode("");
      addr.append(row._addrText);
      row._h = [];
      row._a = [];
      row._ht = [];
      row._at = [];
      for (let col = 0; col < COLS; col++) {
        const hexCell = make("span", PAD_HEX);
        const asciiCell = make("span", PAD_ASCII);
        hexCell._c = asciiCell._c = col;
        const hexText = document.createTextNode("");
        const asciiText = document.createTextNode("");
        hexCell.append(hexText);
        asciiCell.append(asciiText);
        hexCell._k = PAD_HEX;
        asciiCell._k = PAD_ASCII;
        hexGroup.append(hexCell);
        asciiGroup.append(asciiCell);
        row._h.push(hexCell);
        row._a.push(asciiCell);
        row._ht.push(hexText);
        row._at.push(asciiText);
      }
      row.append(addr, hexGroup, asciiGroup);
      row._i = -1;
      row._v = -1;
      return row;
    }

    function paintCell(row, col, index, lo, hi) {
      let hexText = "";
      let asciiText = "";
      let hexClass = PAD_HEX;
      let asciiClass = PAD_ASCII;
      if (index < length) {
        const byte = bytes[index];
        let flags = "";
        if (index >= lo && index <= hi) flags += " sel";
        if (index === head && lo >= 0) flags += " cur";
        if (match && index >= match.start && index < match.end) flags += " mat";
        if (index === hover) flags += " hov";
        hexText = HEX[byte];
        asciiText = ASCII[byte];
        hexClass = HEX_CLASS[byte] + flags;
        asciiClass = ASCII_CLASS[byte] + flags;
      }
      const hexCell = row._h[col];
      const asciiCell = row._a[col];
      if (hexCell._t !== hexText) {
        row._ht[col].nodeValue = hexText;
        hexCell._t = hexText;
        row._at[col].nodeValue = asciiText;
      }
      if (hexCell._k !== hexClass) {
        hexCell.className = hexClass;
        hexCell._k = hexClass;
      }
      if (asciiCell._k !== asciiClass) {
        asciiCell.className = asciiClass;
        asciiCell._k = asciiClass;
      }
    }

    function paintRow(row, rowIndex) {
      const range = selRange();
      const lo = range ? range.lo : -1;
      const hi = range ? range.hi : -2;
      if (row._i !== rowIndex) {
        row._i = rowIndex;
        row._addrText.nodeValue = hex(rowIndex * COLS).padStart(addrDigits(), "0") + ":";
      }
      const base = rowIndex * COLS;
      for (let col = 0; col < COLS; col++) paintCell(row, col, base + col, lo, hi);
      row._v = version;
      row.hidden = false;
    }

    function addrDigits() {
      return Math.max(8, hex(Math.max(0, length - 1)).length);
    }

    function viewHeight() {
      return Math.max(0, scroller.clientHeight - HEADER_H);
    }

    // Bodies taller than MAX_SPACER_PX would exceed what browsers can scroll, so the scroll
    // range is capped and mapped proportionally onto the whole body ("virtual" pixels). Below
    // the cap virtual and real scroll positions are identical. `vTop` remembers the exact
    // virtual position of the last programmatic jump (`vTopScroll` = the scrollTop it produced)
    // because the scaled scrollbar cannot address every row.
    function virtualTop() {
      if (!scaled) return scroller.scrollTop;
      const viewH = viewHeight();
      const st = scroller.scrollTop;
      if (Math.abs(st - vTopScroll) > 1) {
        const maxScroll = MAX_SPACER_PX - viewH;
        const maxV = Math.max(0, totalPx - viewH);
        vTop = maxScroll > 0 ? Math.round(clamp(st / maxScroll, 0, 1) * maxV) : 0;
        vTopScroll = st;
      }
      return vTop;
    }

    function setVirtualTop(value) {
      const viewH = viewHeight();
      if (!scaled) {
        scroller.scrollTop = Math.max(0, value);
        return;
      }
      const maxV = Math.max(0, totalPx - viewH);
      vTop = Math.round(clamp(value, 0, maxV));
      scroller.scrollTop = maxV > 0 ? ((MAX_SPACER_PX - viewH) * vTop) / maxV : 0;
      vTopScroll = scroller.scrollTop;
    }

    function render() {
      frame = 0;
      if (destroyed || !bytes) return;
      const viewH = viewHeight();
      if (viewH <= 0) return;
      const top = virtualTop();
      const first = clamp(Math.floor(top / ROW_H) - BUFFER_ROWS, 0, Math.max(0, rowCount - 1));
      const last = Math.min(rowCount - 1, Math.ceil((top + viewH) / ROW_H) + BUFFER_ROWS);
      const need = last - first + 1;
      if (need > pool.length) {
        // Row slots are keyed by `rowIndex % pool.length`, so growing remaps them all.
        const size = need + 2 * BUFFER_ROWS;
        while (pool.length < size) {
          const row = createRow();
          row.hidden = true;
          layer.append(row);
          pool.push(row);
        }
        for (const row of pool) row._v = -1;
      }
      const size = pool.length;
      const used = new Set();
      // Scaled mode keeps rows at the scroll position: y = scrollTop + (rowTop - virtual top).
      const offset = scaled ? Math.round(scroller.scrollTop - top) : 0;
      for (let rowIndex = first; rowIndex <= last; rowIndex++) {
        const slot = rowIndex % size;
        const row = pool[slot];
        used.add(slot);
        if (row._i !== rowIndex || row._v !== version || row.hidden) paintRow(row, rowIndex);
        const y = rowIndex * ROW_H + offset;
        if (row._y !== y) {
          row._y = y;
          row.style.transform = `translateY(${y}px)`;
        }
      }
      for (let slot = 0; slot < size; slot++) {
        if (!used.has(slot) && !pool[slot].hidden) pool[slot].hidden = true;
      }
    }

    function scheduleRender() {
      if (!frame && !destroyed) frame = requestAnimationFrame(render);
    }

    // Repaint every visible row (selection, match or body changed).
    function repaint() {
      version++;
      render();
    }

    // Cheap hover update: only the two cells whose linked highlight moves.
    function setHover(next) {
      if (next === hover) return;
      const previous = hover;
      hover = next;
      const range = selRange();
      const lo = range ? range.lo : -1;
      const hi = range ? range.hi : -2;
      for (const index of [previous, next]) {
        if (index < 0) continue;
        const rowIndex = Math.floor(index / COLS);
        const row = pool.length ? pool[rowIndex % pool.length] : null;
        if (row && row._i === rowIndex && !row.hidden) {
          paintCell(row, index % COLS, index, lo, hi);
        }
      }
    }

    function reveal(index, center = false) {
      const viewH = viewHeight();
      const rowTop = Math.floor(index / COLS) * ROW_H;
      const top = virtualTop();
      if (center) {
        setVirtualTop(rowTop - (viewH - ROW_H) / 2);
      } else if (rowTop < top) {
        setVirtualTop(rowTop);
      } else if (rowTop + ROW_H > top + viewH) {
        setVirtualTop(rowTop + ROW_H - viewH);
      }
    }

    function isRowVisible(index) {
      const rowTop = Math.floor(index / COLS) * ROW_H;
      const top = virtualTop();
      return rowTop >= top && rowTop + ROW_H <= top + viewHeight();
    }

    // -- Status, Data Inspector --

    function updateStatus() {
      const range = selRange();
      if (!bytes) {
        statusSelection.textContent = "";
        statusTotal.textContent = "";
        statusNote.textContent = "";
        statusNote.title = "";
        return;
      }
      if (range) {
        const count = range.hi - range.lo + 1;
        statusSelection.textContent = `0x${hex(range.lo)} - 0x${hex(range.hi)} (0x${hex(count)} | ${count.toLocaleString("en-US")} bytes)`;
      } else {
        statusSelection.textContent = "No selection";
      }
      statusTotal.textContent = `Size 0x${hex(length)} (${length.toLocaleString("en-US")} bytes)`;
      statusNote.textContent = note;
      statusNote.title = note;
    }

    const inspectorRows = new Map();

    function updateInspector() {
      leButton.classList.toggle("active", littleEndian);
      beButton.classList.toggle("active", !littleEndian);
      leButton.setAttribute("aria-pressed", String(littleEndian));
      beButton.setAttribute("aria-pressed", String(!littleEndian));
      if (!bytes || inspector.hidden) return;
      const range = selRange();
      const offset = range ? range.lo : 0;
      inspectorOffset.textContent = `Offset 0x${hex(offset)}`;
      for (const row of HexInspector.inspect(bytes, offset, { littleEndian })) {
        let entry = inspectorRows.get(row.id);
        if (!entry) {
          const label = make("span", "hexv-ilabel");
          const value = makeButton("hexv-ival");
          value.title = "Click to copy";
          value._id = row.id;
          inspectorList.append(label, value);
          entry = { label, value };
          inspectorRows.set(row.id, entry);
        }
        entry.label.textContent = row.label;
        entry.value._label = row.label;
        entry.value._text = row.value;
        entry.value.textContent = row.value == null ? "\u2014" : row.value;
        entry.value.title = row.value == null ? "" : `${row.value} (click to copy)`;
        entry.value.disabled = row.value == null;
      }
    }

    function applyInspectorVisibility() {
      inspector.hidden = !inspectorOpen;
      inspectorButton.setAttribute("aria-pressed", String(inspectorOpen));
      inspectorButton.classList.toggle("active", inspectorOpen);
      updateInspector();
      scheduleRender();
    }

    // Anything that moved the selection or cursor.
    function selectionChanged() {
      repaint();
      updateStatus();
      updateInspector();
    }

    function moveTo(index, extend) {
      if (!length) return;
      const target = clamp(index, 0, length - 1);
      if (extend && anchor >= 0) head = target;
      else anchor = head = target;
      reveal(target);
      selectionChanged();
    }

    function selectAll() {
      if (!length) return;
      anchor = 0;
      head = length - 1;
      selectionChanged();
    }

    // -- Copy --

    function selectionText(format = "hex") {
      if (!bytes) return "";
      const range = selRange();
      return range
        ? HexInspector.formatSelection(bytes, range.lo, range.hi + 1, format)
        : HexInspector.formatSelection(bytes, 0, length, format);
    }

    async function copy(text, what) {
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      message(ok ? `Copied ${what}` : "Copy failed");
    }

    function copySelection(format) {
      const range = selRange();
      if (!range) return;
      const label = COPY_FORMATS.find(([id]) => id === format)?.[1] ?? format;
      const count = range.hi - range.lo + 1;
      copy(selectionText(format), `${count.toLocaleString("en-US")} bytes as ${label}`);
    }

    // -- Copy menu --

    function onWindowPointer(event) {
      if (!menu.contains(event.target) && event.target !== copyButton) closeMenu(false);
    }

    function onWindowKey(event) {
      if (event.key !== "Escape") return;
      // Esc closes this menu before the panel's global Esc handling dismisses the request view.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeMenu(true);
    }

    function openMenu(clientX, clientY) {
      if (!bytes) return;
      const hasSelection = Boolean(selRange());
      for (const item of menuItems) item.disabled = !hasSelection;
      menu.hidden = false;
      const rect = root.getBoundingClientRect();
      const left = clamp(clientX - rect.left, 0, Math.max(0, rect.width - menu.offsetWidth));
      const top = clamp(clientY - rect.top, 0, Math.max(0, rect.height - menu.offsetHeight));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      copyButton.setAttribute("aria-expanded", "true");
      window.addEventListener("pointerdown", onWindowPointer, true);
      window.addEventListener("keydown", onWindowKey, true);
      menu.querySelector("button:not(:disabled)")?.focus();
    }

    function closeMenu(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      copyButton.setAttribute("aria-expanded", "false");
      window.removeEventListener("pointerdown", onWindowPointer, true);
      window.removeEventListener("keydown", onWindowKey, true);
      if (refocus) scroller.focus({ preventScroll: true });
    }

    menu.addEventListener("click", (event) => {
      const item = event.target.closest("button");
      if (!item || item.disabled) return;
      closeMenu(true);
      if (item.dataset.format) copySelection(item.dataset.format);
      else if (item.dataset.action === "all") copy(selectionTextAll(), "entire body as Hex");
      else if (item.dataset.action === "select-all") selectAll();
    });

    menu.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!step) {
        if (event.key === "Tab") closeMenu(true);
        return;
      }
      event.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement);
      items[(at + step + items.length) % items.length]?.focus();
    });

    function selectionTextAll() {
      return bytes ? HexInspector.formatSelection(bytes, 0, length, "hex") : "";
    }

    copyButton.addEventListener("click", () => {
      if (!menu.hidden) {
        closeMenu(true);
        return;
      }
      const rect = copyButton.getBoundingClientRect();
      openMenu(rect.left, rect.bottom);
    });

    // -- Go to, Find --

    function setInvalid(input, invalid) {
      input.setAttribute("aria-invalid", invalid ? "true" : "false");
    }

    function runGoto() {
      if (!bytes) return;
      const text = gotoInput.value.trim();
      let offset = NaN;
      if (/^0x[0-9a-f]+$/i.test(text)) offset = parseInt(text.slice(2), 16);
      else if (/^\d+$/.test(text)) offset = parseInt(text, 10);
      if (!Number.isSafeInteger(offset)) {
        setInvalid(gotoInput, true);
        message("Enter an offset such as 0x40000 or 262144");
        return;
      }
      if (offset >= length) {
        setInvalid(gotoInput, true);
        message(`Offset out of range: the body has ${length.toLocaleString("en-US")} bytes`);
        return;
      }
      setInvalid(gotoInput, false);
      anchor = head = offset;
      reveal(offset, !isRowVisible(offset));
      selectionChanged();
      message(`Went to 0x${hex(offset)}`);
      scroller.focus({ preventScroll: true });
    }

    function runFind(backward) {
      if (!bytes) return;
      const text = findInput.value;
      if (!text.trim()) {
        setInvalid(findInput, false);
        message("Type hex bytes or text to find");
        return;
      }
      const mode = findMode.value;
      const needle = HexInspector.parseNeedle(text, mode);
      if (!needle) {
        setInvalid(findInput, true);
        message(mode === "hex" ? "Enter whole hex bytes, such as ff fe" : "Nothing to find");
        return;
      }
      setInvalid(findInput, false);
      const range = selRange();
      const continuing = Boolean(
        range && match && range.lo === match.start && range.hi === match.end - 1
      );
      let from;
      if (backward) from = range ? range.lo : length;
      else from = range ? (continuing ? range.lo + 1 : range.lo) : 0;
      let at = HexInspector.find(bytes, needle, from, { backward });
      let wrapped = false;
      if (at < 0) {
        at = HexInspector.find(bytes, needle, backward ? length : 0, { backward });
        wrapped = at >= 0;
      }
      if (at < 0) {
        match = null;
        repaint();
        message("Not found");
        return;
      }
      match = { start: at, end: at + needle.length };
      anchor = at;
      head = at + needle.length - 1;
      reveal(at, !isRowVisible(at) || !isRowVisible(head));
      selectionChanged();
      message(`Match at 0x${hex(at)}${wrapped ? " (wrapped)" : ""}`);
    }

    function clearMatch() {
      setInvalid(findInput, false);
      if (!match) return;
      match = null;
      repaint();
    }

    gotoButton.addEventListener("click", runGoto);
    gotoInput.addEventListener("input", () => setInvalid(gotoInput, false));
    findNext.addEventListener("click", () => runFind(false));
    findPrev.addEventListener("click", () => runFind(true));
    findInput.addEventListener("input", clearMatch);
    findMode.addEventListener("change", clearMatch);
    for (const input of [gotoInput, findInput, findMode]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          scroller.focus({ preventScroll: true });
        } else if (event.key === "Enter" && input === gotoInput) {
          event.preventDefault();
          runGoto();
        } else if (event.key === "Enter" && input === findInput) {
          event.preventDefault();
          runFind(event.shiftKey);
        }
      });
    }

    // -- Pointer and keyboard on the grid --

    function indexOfCell(node) {
      const cell = node instanceof Element ? node.closest(".hexv-b") : null;
      if (!cell || cell.classList.contains("pad") || cell._c === undefined) return -1;
      const row = cell.parentElement?.parentElement;
      return row && row._i >= 0 ? row._i * COLS + cell._c : -1;
    }

    // Byte under the pointer; outside the cells (gutter, past the last row) the nearest row's
    // byte in the cursor's column, so dragging past an edge still extends the selection.
    function indexAtPoint(x, y) {
      const hit = document.elementFromPoint(x, y);
      const index = hit ? indexOfCell(hit) : -1;
      if (index >= 0) return index;
      const rect = scroller.getBoundingClientRect();
      const row = clamp(
        Math.floor((y - rect.top - HEADER_H + virtualTop()) / ROW_H),
        0,
        rowCount - 1
      );
      return Math.min(length - 1, row * COLS + (head >= 0 ? head % COLS : 0));
    }

    scroller.addEventListener("scroll", scheduleRender, { passive: true });

    scroller.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !bytes) return;
      const index = indexOfCell(event.target);
      if (index < 0) return;
      event.preventDefault();
      scroller.focus({ preventScroll: true });
      closeMenu(false);
      if (event.shiftKey && anchor >= 0) head = index;
      else anchor = head = index;
      dragging = true;
      scroller.setPointerCapture(event.pointerId);
      selectionChanged();
    });

    scroller.addEventListener("pointermove", (event) => {
      if (!bytes) return;
      if (!dragging) {
        setHover(indexOfCell(event.target));
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const topEdge = rect.top + HEADER_H;
      const boost = scaled ? totalPx / MAX_SPACER_PX : 1;
      if (event.clientY < topEdge) {
        setVirtualTop(virtualTop() - ((topEdge - event.clientY) / 2 + 4) * boost);
      } else if (event.clientY > rect.bottom) {
        setVirtualTop(virtualTop() + ((event.clientY - rect.bottom) / 2 + 4) * boost);
      }
      const index = indexAtPoint(event.clientX, event.clientY);
      if (index >= 0 && index !== head) {
        head = index;
        setHover(index);
        selectionChanged();
      }
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      if (scroller.hasPointerCapture(event.pointerId))
        scroller.releasePointerCapture(event.pointerId);
    }
    scroller.addEventListener("pointerup", endDrag);
    scroller.addEventListener("pointercancel", endDrag);
    scroller.addEventListener("pointerleave", () => {
      if (!dragging) setHover(-1);
    });

    scroller.addEventListener("contextmenu", (event) => {
      const index = indexOfCell(event.target);
      if (index < 0 || !bytes) return;
      event.preventDefault();
      event.stopPropagation();
      const range = selRange();
      if (!range || index < range.lo || index > range.hi) {
        anchor = head = index;
        selectionChanged();
      }
      openMenu(event.clientX, event.clientY);
    });

    scroller.addEventListener("keydown", (event) => {
      if (!bytes || event.altKey) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl) {
        const key = event.key.toLowerCase();
        if (key === "a") selectAll();
        else if (key === "g") {
          gotoInput.focus();
          gotoInput.select();
        } else if (key === "f") {
          findInput.focus();
          findInput.select();
        } else if (key === "c" && selRange()) copySelection("hex");
        else if (key === "home") moveTo(0, event.shiftKey);
        else if (key === "end") moveTo(length - 1, event.shiftKey);
        else return;
        event.preventDefault();
        return;
      }
      const current = head >= 0 ? head : 0;
      const pageBytes = Math.max(1, Math.floor(viewHeight() / ROW_H) - 1) * COLS;
      const rowStart = current - (current % COLS);
      let target;
      switch (event.key) {
        case "ArrowLeft":
          target = current - 1;
          break;
        case "ArrowRight":
          target = current + 1;
          break;
        case "ArrowUp":
          target = current - COLS;
          break;
        case "ArrowDown":
          target = current + COLS;
          break;
        case "PageUp":
          target = current - pageBytes;
          break;
        case "PageDown":
          target = current + pageBytes;
          break;
        case "Home":
          target = rowStart;
          break;
        case "End":
          target = rowStart + COLS - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      // The first movement key only selects the first byte so the cursor has a visible start.
      if (head < 0 && event.key !== "Home" && event.key !== "End") target = 0;
      moveTo(target, event.shiftKey);
    });

    // -- Data Inspector controls --

    inspectorButton.addEventListener("click", () => {
      inspectorOpen = !inspectorOpen;
      applyInspectorVisibility();
    });
    leButton.addEventListener("click", () => {
      littleEndian = true;
      updateInspector();
    });
    beButton.addEventListener("click", () => {
      littleEndian = false;
      updateInspector();
    });
    inspectorList.addEventListener("click", (event) => {
      const value = event.target.closest(".hexv-ival");
      if (!value || value._text == null) return;
      copy(value._text, `${value._label} value`);
      value.classList.add("copied");
      setTimeout(() => value.classList.remove("copied"), 700);
    });

    // -- Layout --

    const observer = new ResizeObserver(() => {
      // A hidden tab reports zero width; keep the layout state until it is shown again.
      if (!root.clientWidth) return;
      const isNarrow = root.clientWidth < NARROW_PX;
      if (isNarrow !== narrow) {
        narrow = isNarrow;
        inspectorOpen = !isNarrow;
        applyInspectorVisibility();
      }
      scheduleRender();
    });
    observer.observe(root);

    // -- Public API --

    function setBytes(next, options = {}) {
      note = options.note ?? "";
      if (next !== bytes) {
        bytes = next || null;
        length = bytes ? bytes.length : 0;
        rowCount = Math.ceil(length / COLS);
        anchor = head = hover = -1;
        match = null;
        dragging = false;
        closeMenu(false);
        totalPx = rowCount * ROW_H;
        scaled = totalPx > MAX_SPACER_PX;
        spacer.style.height = `${scaled ? MAX_SPACER_PX : totalPx}px`;
        root.style.setProperty("--hexv-addr-ch", String(addrDigits() + 1));
        for (const row of pool) {
          row._i = -1;
          row._v = -1;
          row.hidden = true;
        }
        vTop = 0;
        vTopScroll = 0;
        scroller.scrollTop = 0;
        scroller.setAttribute(
          "aria-label",
          `Hex viewer, ${length.toLocaleString("en-US")} bytes. Arrow keys move the cursor and Shift extends the selection.`
        );
        setInvalid(gotoInput, false);
        setInvalid(findInput, false);
        message("");
      }
      selectionChanged();
    }

    function clear() {
      bytes = null;
      length = 0;
      rowCount = 0;
      anchor = head = hover = -1;
      match = null;
      closeMenu(false);
      for (const row of pool) {
        row._i = -1;
        row.hidden = true;
      }
      spacer.style.height = "0";
      updateStatus();
    }

    function destroy() {
      destroyed = true;
      closeMenu(false);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(messageTimer);
      root.remove();
    }

    return {
      setBytes,
      clear,
      destroy,
      focus: () => scroller.focus({ preventScroll: true }),
      selectionText,
      hasSelection: () => Boolean(selRange()),
    };
  }

  return { mount };
})();
