"use strict";

// Source Exporter's own settings, rendered by the unified Settings panel
// (editor-settings.js) next to the generated Monaco editor settings. Each
// definition owns its get/set so the panel stays generic. This replaces the
// old header "gear" popover.
window.AppSettings = (() => {
  const THEMES = [
    { value: "vs-dark", label: "VS Dark (default)" },
    { value: "devtools", label: "DevTools Dark" },
    { value: "source-exporter", label: "Dark (Navy / Charcoal)" },
    { value: "vs", label: "VS Light" },
    { value: "source-exporter-light", label: "Light" },
    { value: "hc-black", label: "High contrast dark" },
    { value: "hc-light", label: "High contrast light" },
  ];

  function setPref(key, value) {
    prefs[key] = value;
    savePref(key, value);
  }

  function applyEditorPreferences() {
    document.documentElement.setAttribute("data-theme", prefs.editorTheme);
    SourceEditor.applyPreferences({
      theme: prefs.editorTheme,
      fontFamily: prefs.editorFontFamily,
      fontSize: prefs.editorFontSize,
      smoothScrolling: !prefs.editorDisableSmoothScroll,
    }).catch(() => {});
  }

  function rerenderPreview() {
    if (state.selectedSection === "requests") showSelectedRequestTab();
    else if (state.selectedPath && state.lastPreviewOriginal) {
      renderContent(state.lastPreviewOriginal, state.lastPreviewLang, state.lastPreviewBadge);
    }
  }

  const DEFINITIONS = [
    {
      id: "editorTheme",
      section: "Appearance",
      label: "Color theme",
      description: "Colors for the whole panel and the code editor.",
      type: "select",
      options: THEMES,
      default: EDITOR_DEFAULTS.theme,
      get: () => prefs.editorTheme,
      set(value) {
        setPref("editorTheme", value);
        applyEditorPreferences();
      },
    },
    {
      id: "editorFontFamily",
      section: "Appearance",
      label: "Editor font family",
      description: "CSS font-family list used by the code editor and request bodies.",
      type: "text",
      default: EDITOR_DEFAULTS.fontFamily,
      get: () => prefs.editorFontFamily,
      set(value) {
        setPref("editorFontFamily", String(value).trim() || EDITOR_DEFAULTS.fontFamily);
        applyEditorPreferences();
      },
    },
    {
      id: "editorFontSize",
      section: "Appearance",
      label: "Editor font size",
      description: "Font size in pixels (8–32).",
      type: "number",
      min: 8,
      max: 32,
      default: EDITOR_DEFAULTS.fontSize,
      get: () => prefs.editorFontSize,
      set(value) {
        const size = Math.min(32, Math.max(8, Number(value) || EDITOR_DEFAULTS.fontSize));
        setPref("editorFontSize", size);
        applyEditorPreferences();
      },
    },
    {
      id: "editorDisableSmoothScroll",
      section: "Appearance",
      label: "Disable smooth scrolling",
      description: "Scroll the editor instantly instead of animating.",
      type: "boolean",
      default: false,
      get: () => prefs.editorDisableSmoothScroll,
      set(value) {
        setPref("editorDisableSmoothScroll", Boolean(value));
        applyEditorPreferences();
      },
    },
    {
      id: "prettyDefault",
      section: "Files & Preview",
      label: "Pretty-format previews by default",
      description:
        "Open minified JS/CSS/HTML/JSON already formatted. You can still toggle per file with Ctrl+Shift+F.",
      type: "boolean",
      default: false,
      get: () => prefs.prettyDefault,
      set(value) {
        setPref("prettyDefault", Boolean(value));
        state.prettyView = prefs.prettyDefault;
        rerenderPreview();
      },
    },
    {
      id: "formatBodies",
      section: "Network",
      label: "Format request & response bodies by default",
      description:
        "Pretty-print JSON, form, HTML and CSS bodies in the request detail view. The Format toggle in the toolbar overrides this per session.",
      type: "boolean",
      default: true,
      get: () => prefs.formatBodies,
      set(value) {
        setPref("formatBodies", Boolean(value));
        state.requestDetailFormat = prefs.formatBodies;
        rerenderPreview();
      },
    },
    {
      id: "prettyOnExport",
      section: "Export",
      label: "Pretty-format files on export",
      description:
        "Files that fail to format fall back to the original, with a note at the top of the file.",
      type: "boolean",
      default: false,
      get: () => prefs.prettyOnExport,
      set: (value) => setPref("prettyOnExport", Boolean(value)),
    },
    {
      id: "archiveFormat",
      section: "Export",
      label: "Archive format",
      description: "Container used for Export All and directory exports.",
      type: "select",
      options: [
        { value: "zip", label: "ZIP" },
        { value: "tar", label: "TAR" },
      ],
      default: "zip",
      get: () => prefs.archiveFormat,
      set(value) {
        setPref("archiveFormat", value === "tar" ? "tar" : "zip");
        el.formatSelect.value = prefs.archiveFormat;
      },
    },
    {
      id: "locationFilterMode",
      section: "Location Filter",
      label: "Match",
      description:
        "Only show (and export) files whose script or source URL matches. Not saved between sessions.",
      type: "select",
      options: [
        { value: "all", label: "All locations" },
        { value: "exact", label: "Exact domain" },
        { value: "subdomains", label: "Domain + subdomains" },
        { value: "regex", label: "URL/location regex" },
      ],
      default: "all",
      get: () => state.locationFilter.mode,
      set: (value) => setLocationFilter(value, state.locationFilter.value),
    },
    {
      id: "locationFilterValue",
      section: "Location Filter",
      label: "Domain or pattern",
      description: "For example example.com, or github\\.com|cdn\\. in regex mode.",
      type: "text",
      default: "",
      get: () => state.locationFilter.value,
      set: (value) => setLocationFilter(state.locationFilter.mode, String(value)),
      status: () => locationFilterStatusText(),
      statusIsError: () => Boolean(state.locationFilter.error),
    },
  ];

  function list() {
    return DEFINITIONS;
  }

  return { list, applyEditorPreferences };
})();
