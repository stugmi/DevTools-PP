"use strict";

// App settings definitions (theme, preview, network, export, source filter).
// Rendered by the Settings panel in editor-settings.js; each definition owns its get/set.
// Loaded after capture/export code it calls and before layout.js.
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
      tsDiagnostics: prefs.tsDiagnostics,
    }).catch(() => {});
    window.RequestViewer.applyPreferences();
  }

  function rerenderPreview() {
    if (state.selectedSection === "requests") showSelectedRequestTab();
    else if (state.selectedPath && state.lastPreviewOriginal) {
      renderContent(state.lastPreviewOriginal, state.lastPreviewLang, state.lastPreviewBadge);
    }
  }

  // Stores one code formatting pref, applies the new style and redraws what the preview shows.
  function setCodeFormat(key, value) {
    setPref(key, value);
    CodeFormat.configure(codeFormatStyle());
    rerenderPreview();
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
      description: `Open minified JS/CSS/HTML/JSON already formatted. You can still toggle per file with ${Keybinds.label("file.format")}.`,
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
      id: "tsDiagnostics",
      section: "Files & Preview",
      label: "TypeScript diagnostics for authored files",
      description:
        "Source maps only contain the site's own files, so imports of packages and path aliases can't always be resolved. Smart hides those unresolved import/name errors but keeps real type errors.",
      type: "select",
      options: [
        { value: "smart", label: "Smart (hide unresolved imports)" },
        { value: "syntax", label: "Syntax errors only" },
        { value: "off", label: "Off" },
      ],
      default: "smart",
      get: () => prefs.tsDiagnostics,
      set(value) {
        setPref("tsDiagnostics", value);
        applyEditorPreferences();
      },
    },
    {
      id: "codeBraceStyle",
      section: "Code Formatting",
      label: "Braces and objects",
      description:
        "Applies to pretty-formatted JS/TS and the scripts inside HTML. Smart leaves short imports, objects and blocks on one line when the file is already formatted, and expands minified code.",
      type: "select",
      options: CodeFormat.BRACE_STYLES,
      default: CodeFormat.DEFAULTS.braceStyle,
      get: () => codeFormatStyle().braceStyle,
      set: (value) => setCodeFormat("codeBraceStyle", value),
    },
    {
      id: "codeKeepArrayLayout",
      section: "Code Formatting",
      label: "Keep array layout",
      description: "Leave arrays exactly as written instead of re-breaking their lines.",
      type: "boolean",
      default: CodeFormat.DEFAULTS.keepArrayLayout,
      get: () => codeFormatStyle().keepArrayLayout,
      set: (value) => setCodeFormat("codeKeepArrayLayout", Boolean(value)),
    },
    {
      id: "codeIndentTabs",
      section: "Code Formatting",
      label: "Indent with tabs",
      description: "Use tab characters instead of spaces.",
      type: "boolean",
      default: CodeFormat.DEFAULTS.indentTabs,
      get: () => codeFormatStyle().indentTabs,
      set: (value) => setCodeFormat("codeIndentTabs", Boolean(value)),
    },
    {
      id: "codeIndentSize",
      section: "Code Formatting",
      label: "Indent size",
      description: "Spaces per indent level (1-8). Also the JSON indent.",
      type: "number",
      min: CodeFormat.LIMITS.indentSize.min,
      max: CodeFormat.LIMITS.indentSize.max,
      default: CodeFormat.DEFAULTS.indentSize,
      get: () => codeFormatStyle().indentSize,
      set: (value) => setCodeFormat("codeIndentSize", value),
    },
    {
      id: "codePreserveBlankLines",
      section: "Code Formatting",
      label: "Keep blank lines",
      description: "Keep the blank lines between statements, up to the limit below.",
      type: "boolean",
      default: CodeFormat.DEFAULTS.preserveBlankLines,
      get: () => codeFormatStyle().preserveBlankLines,
      set: (value) => setCodeFormat("codePreserveBlankLines", Boolean(value)),
    },
    {
      id: "codeMaxBlankLines",
      section: "Code Formatting",
      label: "Max consecutive blank lines",
      description: "Longer runs of blank lines are shortened to this many (0-5).",
      type: "number",
      min: CodeFormat.LIMITS.maxBlankLines.min,
      max: CodeFormat.LIMITS.maxBlankLines.max,
      default: CodeFormat.DEFAULTS.maxBlankLines,
      get: () => codeFormatStyle().maxBlankLines,
      set: (value) => setCodeFormat("codeMaxBlankLines", value),
    },
    {
      id: "codeWrapLineLength",
      section: "Code Formatting",
      label: "Wrap long lines at",
      description: "Column to wrap code at (0 turns wrapping off).",
      type: "number",
      min: CodeFormat.LIMITS.wrapLineLength.min,
      max: CodeFormat.LIMITS.wrapLineLength.max,
      default: CodeFormat.DEFAULTS.wrapLineLength,
      get: () => codeFormatStyle().wrapLineLength,
      set: (value) => setCodeFormat("codeWrapLineLength", value),
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
      id: "requestCopyFormat",
      section: "Network",
      label: "Default Copy as format",
      description:
        "Preferred request replay format. Other formats remain available in the request menu.",
      type: "select",
      options: RequestCode.FORMATS,
      default: RequestCode.DEFAULT_FORMAT,
      get: () => prefs.requestCopyFormat,
      set(value) {
        if (RequestCode.FORMATS.some((format) => format.value === value)) {
          setPref("requestCopyFormat", value);
        }
      },
    },
    {
      id: "requestCodePythonLibrary",
      section: "Network",
      label: "Python library",
      description:
        "The package Copy as Python writes for: requests (default) or httpx. httpx can also replay duplicate headers and URL spellings that requests would rewrite.",
      type: "select",
      options: RequestCode.PYTHON_LIBRARIES,
      default: RequestCode.DEFAULT_PYTHON_LIBRARY,
      get: () => prefs.requestCodePythonLibrary,
      set(value) {
        if (RequestCode.PYTHON_LIBRARIES.some((option) => option.value === value)) {
          setPref("requestCodePythonLibrary", value);
        }
      },
    },
    {
      id: "requestCodeLineWidth",
      section: "Network",
      label: "Replay line width",
      description:
        "Preferred width for copied request code, at least 40 columns with no upper limit. Header values and string values inside JSON or form structures stay on one line, and shell transport commands may exceed it.",
      type: "number",
      min: 40,
      default: RequestCode.DEFAULT_LINE_WIDTH,
      get: () => prefs.requestCodeLineWidth,
      set(value) {
        setPref("requestCodeLineWidth", RequestCode.normalizeLineWidth(value));
      },
    },
    {
      id: "requestCodePythonNestedJson",
      section: "Network",
      label: "Embedded JSON in Python",
      description:
        "How Python replays write string values that hold JSON text, such as analytics fields: through a stringify(...) helper function declared above the request (default), the same helper bound inline with a walrus (Python 3.8+), or an inline json.dumps(...) per value.",
      type: "select",
      options: RequestCode.PYTHON_NESTED_JSON,
      default: RequestCode.DEFAULT_PYTHON_NESTED_JSON,
      get: () => prefs.requestCodePythonNestedJson,
      set(value) {
        if (RequestCode.PYTHON_NESTED_JSON.some((option) => option.value === value)) {
          setPref("requestCodePythonNestedJson", value);
        }
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
      id: "sourceFilterEnabled",
      section: "Source Filter",
      label: "Apply the source filter",
      description:
        "Turn the include and exclude rules off without clearing them. Also in the Files toolbar filter button.",
      type: "boolean",
      default: true,
      get: () => prefs.sourceFilterEnabled,
      set: (value) => setSourceFilter({ enabled: Boolean(value) }),
    },
    {
      id: "sourceFilterInclude",
      section: "Source Filter",
      label: "Include",
      description: `Only show (and export) files matching one of these comma separated rules. ${SOURCE_FILTER_SYNTAX}`,
      type: "text",
      default: "",
      get: () => prefs.sourceFilterInclude,
      set: (value) => setSourceFilter({ include: String(value) }),
      status: () => sourceFilterRuleStatus(state.sourceFilter.includeErrors),
      statusIsError: () => state.sourceFilter.includeErrors.length > 0,
    },
    {
      id: "sourceFilterExclude",
      section: "Source Filter",
      label: "Exclude",
      description: "Hide files matching any of these rules, even when they match an include rule.",
      type: "text",
      default: "",
      get: () => prefs.sourceFilterExclude,
      set: (value) => setSourceFilter({ exclude: String(value) }),
      status: () => sourceFilterRuleStatus(state.sourceFilter.excludeErrors),
      statusIsError: () => state.sourceFilter.excludeErrors.length > 0,
    },
    {
      id: "sourceGroupBy",
      section: "Source Filter",
      label: "Group files by",
      description:
        "How the explorer groups files. Automatic groups Authored files by domain and leaves Deployed files ungrouped.",
      type: "select",
      options: SOURCE_GROUP_OPTIONS,
      default: "auto",
      get: () => prefs.sourceGroupBy,
      set: (value) => setSourceGrouping({ groupBy: value }),
    },
    {
      id: "sourceNestFolders",
      section: "Source Filter",
      label: "Nest files in folders",
      description: "Turn off to list each group's files by full path instead of as a folder tree.",
      type: "boolean",
      default: true,
      get: () => prefs.sourceNestFolders,
      set: (value) => setSourceGrouping({ nestFolders: Boolean(value) }),
    },
  ];

  function list() {
    return DEFINITIONS;
  }

  return { list, applyEditorPreferences };
})();
