"use strict";

// Settings window: DevTools++'s own settings (AppSettings) followed by every Monaco editor
// option, generated from Monaco's EditorOptions schema. Also owns the floating window and the
// Monaco JSON overrides view. fontFamily, fontSize and smoothScrolling are left out of the
// Monaco list because the Appearance section owns them.
// Loaded after editor.js (uses SourceEditor.ready); Esc handling lives in keyboard.js.
window.EditorSettingsPanel = (() => {
  const STORAGE_KEY = "se.monacoRawSettings";
  const EXCLUDED_OPTIONS = new Set(["fontFamily", "fontSize", "smoothScrolling"]);
  const EDITOR_SECTION = "Editor";

  let entries = [];
  let entryByDotted = new Map();
  let overrides = loadOverrides();
  let editorRef = null;
  let monacoRef = null;
  let jsonEditor = null;
  let jsonModel = null;
  let mode = "ui";
  let searchText = "";
  let suppressJsonSync = false;
  let jsonApplyTimer = null;
  let returnFocusTo = null;

  const modal = document.getElementById("editor-settings-modal");
  const body = document.getElementById("es-body");
  const nav = document.getElementById("es-nav");
  const searchInput = document.getElementById("es-search");
  const modeToggle = document.getElementById("es-mode-toggle");
  const resetAllBtn = document.getElementById("es-reset-all");
  const closeBtn = document.getElementById("es-close");
  const jsonWrap = document.getElementById("es-json-wrap");
  const jsonStatus = document.getElementById("es-json-status");
  const countEl = document.getElementById("es-count");
  const triggerBtn = document.getElementById("btn-settings");

  function loadOverrides() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveOverrides() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // ignore storage failures
    }
  }

  function titleCase(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  }

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  // Compound options (stickyScroll, minimap, suggest, ...) expose their schema as a dict of
  // dotted VSCode-style keys; scalar options expose a single descriptor directly. Dotted keys
  // never collide with JSON Schema keywords (which never contain "."), so this tells the two
  // shapes apart.
  function isCompoundSchema(schema) {
    const keys = Object.keys(schema || {});
    return keys.length > 0 && keys.every((k) => k.includes("."));
  }

  function buildEntries(monaco) {
    const list = [];
    for (const key of Object.keys(monaco.editor.EditorOptions)) {
      const meta = monaco.editor.EditorOptions[key];
      if (!meta || typeof meta !== "object" || !meta.schema) continue;
      const name = meta.name;
      if (!name || EXCLUDED_OPTIONS.has(name)) continue;
      const schema = meta.schema;
      if (isCompoundSchema(schema)) {
        for (const [dottedKey, descriptor] of Object.entries(schema)) {
          if (!descriptor || typeof descriptor !== "object") continue;
          const segments = dottedKey.split(".");
          const path = segments.length > 2 ? segments.slice(2) : [];
          list.push({ optionName: name, path, descriptor, dottedKey, meta });
        }
      } else {
        list.push({
          optionName: name,
          path: [],
          descriptor: schema,
          dottedKey: `editor.${name}`,
          meta,
        });
      }
    }
    list.sort((a, b) => a.dottedKey.localeCompare(b.dottedKey));
    return list;
  }

  function getPath(obj, path) {
    let v = obj;
    for (const p of path) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }

  function setPath(path, value) {
    if (!path.length) return value;
    const out = {};
    let cur = out;
    for (let i = 0; i < path.length - 1; i++) {
      cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
    return out;
  }

  function liveValue(entry) {
    const full = editorRef.getOption(entry.meta.id);
    return entry.path.length ? getPath(full, entry.path) : full;
  }

  function defaultValue(entry) {
    const full = entry.meta.defaultValue;
    return entry.path.length ? getPath(full, entry.path) : full;
  }

  // Monaco's compound options (minimap, stickyScroll, suggest, ...) merge
  // partial updates over the existing value, so a single-field patch is safe.
  function applyLeaf(entry, value) {
    try {
      editorRef.updateOptions({ [entry.optionName]: setPath(entry.path, value) });
    } catch (error) {
      console.warn(`DevTools++: could not apply ${entry.dottedKey}`, error);
    }
  }

  function setOverride(dottedKey, value) {
    overrides[dottedKey] = value;
    saveOverrides();
    const entry = entryByDotted.get(dottedKey);
    if (entry) applyLeaf(entry, value);
  }

  function clearOverride(dottedKey) {
    if (!(dottedKey in overrides)) return;
    delete overrides[dottedKey];
    saveOverrides();
    const entry = entryByDotted.get(dottedKey);
    if (entry) applyLeaf(entry, defaultValue(entry));
  }

  function typeMatches(type, value) {
    switch (type) {
      case "boolean":
        return typeof value === "boolean";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return Number.isInteger(value);
      case "string":
        return typeof value === "string";
      case "null":
        return value === null;
      case "array":
        return Array.isArray(value);
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      default:
        return true;
    }
  }

  function valueFitsEntry(entry, value) {
    const { type, enum: allowed } = entry.descriptor;
    if (Array.isArray(allowed) && !allowed.includes(value)) return false;
    if (!type) return true;
    return (Array.isArray(type) ? type : [type]).some((item) => typeMatches(item, value));
  }

  // Keeps only keys that are known Monaco options with a value of the right type.
  function sanitizeOverrides(raw) {
    const clean = {};
    const ignored = [];
    for (const [dottedKey, value] of Object.entries(raw)) {
      const entry = entryByDotted.get(dottedKey);
      if (entry && valueFitsEntry(entry, value)) clean[dottedKey] = value;
      else ignored.push(dottedKey);
    }
    return { clean, ignored };
  }

  function applyStoredOverrides() {
    const { clean, ignored } = sanitizeOverrides(overrides);
    if (ignored.length) {
      overrides = clean;
      saveOverrides();
    }
    for (const [dottedKey, value] of Object.entries(overrides)) {
      applyLeaf(entryByDotted.get(dottedKey), value);
    }
  }

  // `next` must already be sanitized.
  function replaceOverrides(next) {
    const nextKeys = new Set(Object.keys(next));
    for (const dottedKey of Object.keys(overrides)) {
      if (nextKeys.has(dottedKey)) continue;
      const entry = entryByDotted.get(dottedKey);
      if (entry) applyLeaf(entry, defaultValue(entry));
    }
    overrides = next;
    saveOverrides();
    for (const [dottedKey, value] of Object.entries(overrides)) {
      const entry = entryByDotted.get(dottedKey);
      if (entry) applyLeaf(entry, value);
    }
  }

  // -- Uniform definition objects for both kinds of setting --

  function monacoDefinition(entry) {
    const desc = entry.descriptor;
    const description = (desc.description || desc.markdownDescription || "").replace(/`/g, "");
    let type = "json";
    if (desc.type === "boolean") type = "boolean";
    else if (desc.type === "number") type = "number";
    else if (desc.type === "string") type = Array.isArray(desc.enum) ? "select" : "text";
    return {
      id: entry.dottedKey,
      key: entry.dottedKey,
      label: entry.path.length
        ? titleCase(entry.path[entry.path.length - 1])
        : titleCase(entry.optionName),
      description,
      type,
      options: desc.enum,
      min: desc.minimum,
      max: desc.maximum,
      tag: Array.isArray(desc.tags) ? desc.tags.join(", ") : "",
      get: () => liveValue(entry),
      set: (value) => setOverride(entry.dottedKey, value),
      isModified: () => entry.dottedKey in overrides,
      reset: () => clearOverride(entry.dottedKey),
    };
  }

  function appDefinition(def) {
    return {
      ...def,
      key: `se.${def.id}`,
      isModified: () => def.get() !== def.default,
      reset: () => def.set(def.default),
    };
  }

  function matchesSearch(def, sectionTitle) {
    if (!searchText) return true;
    const haystack = `${def.label} ${def.key || ""} ${def.description || ""} ${sectionTitle}`;
    return searchText.split(/\s+/).every((part) => haystack.toLowerCase().includes(part));
  }

  // -- Row rendering --

  function optionList(options) {
    return options.map((opt) => (typeof opt === "object" ? opt : { value: opt, label: opt }));
  }

  function buildControl(def, id) {
    const value = def.get();
    let control;
    if (def.type === "boolean") {
      control = document.createElement("input");
      control.type = "checkbox";
      control.checked = Boolean(value);
      control.addEventListener("change", () => def.set(control.checked));
    } else if (def.type === "number") {
      control = document.createElement("input");
      control.type = "number";
      if (typeof def.min === "number") control.min = def.min;
      if (typeof def.max === "number") control.max = def.max;
      control.value = value ?? "";
      control.addEventListener("change", () => {
        const num = Number(control.value);
        if (!Number.isNaN(num)) def.set(num);
      });
    } else if (def.type === "select") {
      control = document.createElement("select");
      for (const opt of optionList(def.options)) {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        control.appendChild(optionEl);
      }
      control.value = value;
      control.addEventListener("change", () => def.set(control.value));
    } else if (def.type === "text") {
      control = document.createElement("input");
      control.type = "text";
      control.spellcheck = false;
      control.value = value ?? "";
      control.addEventListener("change", () => def.set(control.value));
    } else {
      control = document.createElement("textarea");
      control.className = "es-json-fallback";
      control.spellcheck = false;
      control.value = JSON.stringify(value ?? null, null, 2);
      control.addEventListener("change", () => {
        try {
          def.set(JSON.parse(control.value));
        } catch {
          // Invalid JSON: leave the stored value untouched.
        }
      });
    }
    control.id = id;
    return control;
  }

  function renderRow(def) {
    const row = document.createElement("div");
    row.className = "es-row";
    row.classList.toggle("modified", def.isModified());
    row.dataset.settingKey = def.key || def.id;
    const controlId = `es-ctrl-${slug(def.key || def.id)}`;
    const control = buildControl(def, controlId);
    const isCheckbox = def.type === "boolean";

    const head = document.createElement("div");
    head.className = "es-row-head";
    const label = document.createElement("label");
    label.className = "es-row-label";
    label.htmlFor = controlId;
    if (isCheckbox) {
      label.appendChild(control);
      label.append(def.label);
    } else {
      label.textContent = def.label;
    }
    head.appendChild(label);
    if (def.tag) {
      const tag = document.createElement("span");
      tag.className = "es-tag";
      tag.textContent = def.tag;
      head.appendChild(tag);
    }
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "es-reset-btn";
    resetBtn.title = "Reset to default";
    resetBtn.setAttribute("aria-label", `Reset ${def.label} to default`);
    resetBtn.textContent = "↺";
    resetBtn.disabled = !def.isModified();
    resetBtn.addEventListener("click", () => {
      def.reset();
      // The JSON fallback textarea is not re-read by refresh() (it would drop invalid input).
      if (def.type === "json") control.value = JSON.stringify(def.get() ?? null, null, 2);
      refresh();
    });
    head.appendChild(resetBtn);
    row.appendChild(head);

    if (def.description) {
      const hint = document.createElement("div");
      hint.className = "es-row-hint";
      hint.textContent = def.description;
      row.appendChild(hint);
    }
    if (!isCheckbox) {
      const controlWrap = document.createElement("div");
      controlWrap.className = "es-row-control";
      controlWrap.appendChild(control);
      row.appendChild(controlWrap);
    }
    let statusEl = null;
    if (def.status) {
      statusEl = document.createElement("div");
      statusEl.className = "es-row-status";
      row.appendChild(statusEl);
    }

    // Keep the control value, "modified" marker, reset button and status text in sync without
    // re-rendering (which would steal focus). Re-reading the value shows clamped/blank input.
    const refresh = () => {
      const current = def.get();
      if (def.type === "boolean") control.checked = Boolean(current);
      else if (def.type === "number" || def.type === "text" || def.type === "select") {
        control.value = current ?? "";
      }
      const modified = def.isModified();
      row.classList.toggle("modified", modified);
      resetBtn.disabled = !modified;
      if (statusEl) {
        statusEl.textContent = def.status();
        statusEl.classList.toggle("error", Boolean(def.statusIsError?.()));
      }
    };
    control.addEventListener("change", () => setTimeout(refresh, 0));
    refresh();
    return row;
  }

  function renderBody() {
    const scrollTop = body.scrollTop;
    body.replaceChildren();
    nav.replaceChildren();
    let shown = 0;
    const navItems = [];

    const sections = new Map();
    for (const def of window.AppSettings?.list() ?? []) {
      if (!matchesSearch(def, def.section)) continue;
      if (!sections.has(def.section)) sections.set(def.section, []);
      sections.get(def.section).push(appDefinition(def));
    }
    for (const [title, defs] of sections) {
      const section = document.createElement("section");
      section.className = "es-section";
      section.id = `es-sec-${slug(title)}`;
      const heading = document.createElement("h2");
      heading.className = "es-section-title";
      heading.textContent = title;
      section.appendChild(heading);
      for (const def of defs) section.appendChild(renderRow(def));
      body.appendChild(section);
      navItems.push({ id: section.id, title, group: "DevTools++" });
      shown += defs.length;
    }

    if (editorRef && entries.length) {
      const groups = new Map();
      let editorShown = 0;
      for (const entry of entries) {
        const def = monacoDefinition(entry);
        if (!matchesSearch(def, `${EDITOR_SECTION} ${entry.optionName}`)) continue;
        if (!groups.has(entry.optionName)) groups.set(entry.optionName, []);
        groups.get(entry.optionName).push(def);
        editorShown++;
      }
      if (editorShown) {
        const section = document.createElement("section");
        section.className = "es-section";
        section.id = `es-sec-${slug(EDITOR_SECTION)}`;
        const heading = document.createElement("h2");
        heading.className = "es-section-title";
        heading.textContent = EDITOR_SECTION;
        section.appendChild(heading);
        for (const name of Array.from(groups.keys()).sort()) {
          const groupEl = document.createElement("div");
          groupEl.className = "es-group";
          const title = document.createElement("h3");
          title.className = "es-group-title";
          title.textContent = titleCase(name);
          groupEl.appendChild(title);
          for (const def of groups.get(name)) groupEl.appendChild(renderRow(def));
          section.appendChild(groupEl);
        }
        body.appendChild(section);
        navItems.push({
          id: section.id,
          title: `${EDITOR_SECTION} (Monaco)`,
          group: "Code editor",
        });
        shown += editorShown;
      }
    }

    let lastGroup = null;
    for (const item of navItems) {
      if (item.group !== lastGroup) {
        const groupLabel = document.createElement("div");
        groupLabel.className = "es-nav-group";
        groupLabel.textContent = item.group;
        nav.appendChild(groupLabel);
        lastGroup = item.group;
      }
      const link = document.createElement("button");
      link.type = "button";
      link.className = "es-nav-item";
      link.dataset.target = item.id;
      link.textContent = item.title;
      link.addEventListener("click", () => {
        document.getElementById(item.id)?.scrollIntoView({ block: "start" });
      });
      nav.appendChild(link);
    }

    countEl.textContent = `${shown} setting${shown === 1 ? "" : "s"}`;
    if (shown === 0) {
      const empty = document.createElement("div");
      empty.className = "es-empty";
      empty.textContent = "No settings match your search.";
      body.appendChild(empty);
    }
    body.scrollTop = scrollTop;
    updateNavSpy();
  }

  function updateNavSpy() {
    const sections = Array.from(body.querySelectorAll(".es-section"));
    if (!sections.length) return;
    const top = body.getBoundingClientRect().top + 24;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= top) current = section;
    }
    for (const link of nav.querySelectorAll(".es-nav-item")) {
      link.classList.toggle("active", link.dataset.target === current.id);
    }
  }

  // -- JSON editing of the Monaco overrides --

  function jsonSchemaFromEntries() {
    const properties = {};
    for (const entry of entries) {
      properties[entry.dottedKey] = entry.descriptor;
    }
    return { type: "object", properties, additionalProperties: false };
  }

  let jsonSchemas = null;

  // The JSON view wants strict diagnostics (no comments), but those options are global to every
  // JSON model, including .json files in the main editor. Only apply them while the view is shown.
  function applyJsonDiagnostics() {
    if (!jsonSchemas) return;
    const strict = isOpen() && mode === "json";
    monacoRef.languages.json?.jsonDefaults?.setDiagnosticsOptions({
      validate: true,
      allowComments: !strict,
      schemas: jsonSchemas,
    });
  }

  async function ensureJsonEditor() {
    if (jsonEditor || !monacoRef) return;
    const monaco = monacoRef;
    const uri = monaco.Uri.parse("inmemory://devtools-plus-plus/editor-settings.json");
    jsonSchemas = [
      {
        uri: "http://devtools-plus-plus/editor-settings-schema.json",
        fileMatch: [uri.toString()],
        schema: jsonSchemaFromEntries(),
      },
    ];
    jsonModel = monaco.editor.createModel(JSON.stringify(overrides, null, 2) + "\n", "json", uri);
    jsonEditor = monaco.editor.create(document.getElementById("es-json-editor"), {
      model: jsonModel,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
    });
    jsonModel.onDidChangeContent(() => {
      if (!suppressJsonSync) queueJsonApply();
    });
    applyJsonDiagnostics();
  }

  function queueJsonApply() {
    clearTimeout(jsonApplyTimer);
    jsonApplyTimer = setTimeout(() => {
      const text = jsonModel.getValue();
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Settings JSON must be an object");
        }
        const { clean, ignored } = sanitizeOverrides(parsed);
        replaceOverrides(clean);
        jsonStatus.textContent = ignored.length
          ? `Applied; ignored unknown or invalid: ${ignored.join(", ")}`
          : "Applied";
        jsonStatus.classList.toggle("es-json-error", ignored.length > 0);
      } catch (error) {
        jsonStatus.textContent = `Not applied: ${error.message}`;
        jsonStatus.classList.add("es-json-error");
      }
    }, 400);
  }

  function syncJsonFromOverrides() {
    if (!jsonModel) return;
    suppressJsonSync = true;
    jsonModel.setValue(JSON.stringify(overrides, null, 2) + "\n");
    suppressJsonSync = false;
    jsonStatus.textContent = "";
    jsonStatus.classList.remove("es-json-error");
  }

  function setMode(next) {
    mode = next;
    const isJson = mode === "json";
    jsonWrap.hidden = !isJson;
    body.hidden = isJson;
    nav.hidden = isJson;
    modeToggle.classList.toggle("active", isJson);
    modeToggle.setAttribute("aria-pressed", String(isJson));
    modeToggle.textContent = isJson ? "UI view" : "{ } Editor JSON";
    applyJsonDiagnostics();
    if (isJson) {
      ensureJsonEditor().then(() => {
        syncJsonFromOverrides();
        jsonEditor?.layout();
        jsonEditor?.focus();
      });
    } else {
      renderBody();
    }
  }

  // -- Floating window: drag by the header, resize from any edge --
  const WINDOW_KEY = "se.settingsWindow";
  const MIN_WIDTH = 520;
  const MIN_HEIGHT = 340;
  const box = modal?.querySelector(".es-box");
  let windowRect = null;

  function defaultRect() {
    const w = Math.min(1040, window.innerWidth - 32);
    const h = Math.min(760, window.innerHeight - 40);
    return {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      w,
      h,
    };
  }

  // Keeps the window usable: never smaller than the minimum (or bigger than the
  // viewport) and always with enough of the title bar on screen to grab.
  function clampRect(rect) {
    const w = Math.min(Math.max(rect.w, MIN_WIDTH), window.innerWidth);
    const h = Math.min(Math.max(rect.h, MIN_HEIGHT), window.innerHeight);
    const x = Math.min(Math.max(rect.x, 120 - w), window.innerWidth - 120);
    const y = Math.min(Math.max(rect.y, 0), window.innerHeight - 36);
    return { x, y, w, h };
  }

  function loadRect() {
    try {
      const saved = JSON.parse(localStorage.getItem(WINDOW_KEY) || "null");
      if (saved && ["x", "y", "w", "h"].every((key) => Number.isFinite(saved[key]))) return saved;
    } catch {
      // fall through to the default
    }
    return null;
  }

  function applyRect() {
    if (!box) return;
    windowRect = clampRect(windowRect || loadRect() || defaultRect());
    box.style.left = `${windowRect.x}px`;
    box.style.top = `${windowRect.y}px`;
    box.style.width = `${windowRect.w}px`;
    box.style.height = `${windowRect.h}px`;
  }

  function saveRect() {
    try {
      localStorage.setItem(WINDOW_KEY, JSON.stringify(windowRect));
    } catch {
      // ignore storage failures
    }
  }

  // Runs `update(dx, dy)` for every move of a pointer gesture started on `handle`.
  function trackPointer(handle, event, update) {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    box.classList.add("dragging");
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...windowRect };
    const onMove = (moveEvent) => {
      windowRect = clampRect(update(start, moveEvent.clientX - startX, moveEvent.clientY - startY));
      applyRect();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      box.classList.remove("dragging");
      saveRect();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function initWindow() {
    if (!box) return;
    const header = box.querySelector(".es-header");
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("input, button, select, textarea")) return;
      trackPointer(header, event, (start, dx, dy) => ({
        ...start,
        x: start.x + dx,
        y: start.y + dy,
      }));
    });
    header.addEventListener("dblclick", (event) => {
      if (event.target.closest("input, button, select, textarea")) return;
      windowRect = defaultRect();
      applyRect();
      saveRect();
    });
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = document.createElement("div");
      handle.className = `es-resize es-resize-${edge}`;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        trackPointer(handle, event, (start, dx, dy) => {
          const next = { ...start };
          if (edge.includes("e")) next.w = Math.max(MIN_WIDTH, start.w + dx);
          if (edge.includes("s")) next.h = Math.max(MIN_HEIGHT, start.h + dy);
          if (edge.includes("w")) {
            next.w = Math.max(MIN_WIDTH, start.w - dx);
            next.x = start.x + (start.w - next.w);
          }
          if (edge.includes("n")) {
            next.h = Math.max(MIN_HEIGHT, start.h - dy);
            next.y = start.y + (start.h - next.h);
          }
          return next;
        });
      });
      box.appendChild(handle);
    }
    window.addEventListener("resize", () => {
      if (isOpen()) applyRect();
    });
  }

  // -- Open / close --

  function isOpen() {
    return Boolean(modal) && !modal.hidden;
  }

  // `section` (optional) is a title like "Location Filter" to scroll to.
  // `query` (optional) pre-fills the search box so only matching settings show.
  function open(section, { query } = {}) {
    if (!modal) return;
    returnFocusTo = document.activeElement;
    modal.hidden = false;
    applyRect();
    applyJsonDiagnostics();
    if (query != null) {
      searchInput.value = query;
      searchText = query.trim().toLowerCase();
      if (mode !== "ui") setMode("ui");
    }
    if (mode === "ui") renderBody();
    else syncJsonFromOverrides();
    if (section) document.getElementById(`es-sec-${slug(section)}`)?.scrollIntoView();
    searchInput.focus();
  }

  // -- Command palette items --

  function shortValue(def) {
    const value = def.get();
    if (value === undefined || value === null || value === "") return "Not set";
    if (typeof value === "boolean") return value ? "On" : "Off";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return text.length > 40 ? `${text.slice(0, 39)}...` : text;
  }

  function commandFor(def, group) {
    if (def.type === "boolean") {
      return {
        label: `Toggle ${group}: ${def.label}`,
        detail: def.get() ? "On" : "Off",
        run: () => {
          def.set(!def.get());
          if (isOpen() && mode === "ui") renderBody();
        },
      };
    }
    return {
      label: `Settings: ${group}: ${def.label}`,
      detail: shortValue(def),
      run: () => open(null, { query: def.label }),
    };
  }

  // Built fresh each time the palette opens so details show current values.
  function commands() {
    const items = [];
    for (const raw of window.AppSettings?.list() ?? []) {
      const def = appDefinition(raw);
      items.push(commandFor(def, def.section));
    }
    if (editorRef) {
      for (const entry of entries) {
        const def = monacoDefinition(entry);
        if (def.type === "json") continue;
        items.push(commandFor(def, titleCase(entry.optionName)));
      }
    }
    return items;
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    applyJsonDiagnostics();
    if (returnFocusTo && typeof returnFocusTo.focus === "function") returnFocusTo.focus();
    returnFocusTo = null;
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function resetAll() {
    for (const def of window.AppSettings?.list() ?? []) {
      const full = appDefinition(def);
      if (full.isModified()) full.reset();
    }
    if (editorRef) replaceOverrides({});
    if (mode === "ui") renderBody();
    syncJsonFromOverrides();
  }

  let searchTimer = null;
  searchInput?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchText = searchInput.value.trim().toLowerCase();
      renderBody();
    }, 120);
  });
  body?.addEventListener("scroll", updateNavSpy, { passive: true });
  modeToggle?.addEventListener("click", () => setMode(mode === "ui" ? "json" : "ui"));
  resetAllBtn?.addEventListener("click", resetAll);
  closeBtn?.addEventListener("click", close);
  triggerBtn?.addEventListener("click", toggle);
  initWindow();

  window.SourceEditor?.ready.then((editor) => {
    editorRef = editor;
    monacoRef = window.monaco;
    entries = buildEntries(monacoRef);
    entryByDotted = new Map(entries.map((entry) => [entry.dottedKey, entry]));
    applyStoredOverrides();
    if (isOpen() && mode === "ui") renderBody();
  });

  return { open, close, toggle, isOpen, commands };
})();
