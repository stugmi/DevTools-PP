// Code formatting style: the user-facing options behind the pretty-format button, pretty-on-export
// and request body formatting, and their translation into js-beautify options. Pure apart from the
// current style held here, which state.js loads from the stored prefs and the Settings window edits.
"use strict";

const CodeFormat = (() => {
  // "auto" keeps short `{a, b}` blocks and objects on one line in code that is already formatted,
  // and fully expands minified code, where keeping inline braces would leave it unreadable.
  const BRACE_STYLES = Object.freeze([
    { value: "auto", label: "Smart (keep short braces inline in formatted code)" },
    { value: "inline", label: "Always keep inline braces on one line" },
    { value: "collapse", label: "Always expand every block and object" },
    { value: "expand", label: "Expand, with braces on their own line" },
  ]);
  const BRACE_STYLE_VALUES = BRACE_STYLES.map(({ value }) => value);

  const LIMITS = Object.freeze({
    indentSize: { min: 1, max: 8 },
    maxBlankLines: { min: 0, max: 5 },
    wrapLineLength: { min: 0, max: 400 },
  });

  const DEFAULTS = Object.freeze({
    indentSize: 2,
    indentTabs: false,
    braceStyle: "auto",
    keepArrayLayout: false,
    preserveBlankLines: true,
    maxBlankLines: 1,
    wrapLineLength: 0,
  });

  // A file counts as minified when most of its text sits on very long lines.
  const MINIFIED_LINE_LENGTH = 300;

  const BEAUTIFY_BRACE_STYLES = {
    inline: "collapse,preserve-inline",
    collapse: "collapse",
    expand: "expand",
  };

  function clampInteger(value, { min, max }, fallback) {
    let number = value;
    if (typeof number === "string" && number.trim() !== "") number = Number(number);
    if (typeof number !== "number" || !Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  }

  // Fills in and clamps a (possibly partial or stale) stored style, so callers never see bad values.
  function normalize(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const flag = (key) => (typeof source[key] === "boolean" ? source[key] : DEFAULTS[key]);
    return {
      indentSize: clampInteger(source.indentSize, LIMITS.indentSize, DEFAULTS.indentSize),
      indentTabs: flag("indentTabs"),
      braceStyle: BRACE_STYLE_VALUES.includes(source.braceStyle)
        ? source.braceStyle
        : DEFAULTS.braceStyle,
      keepArrayLayout: flag("keepArrayLayout"),
      preserveBlankLines: flag("preserveBlankLines"),
      maxBlankLines: clampInteger(
        source.maxBlankLines,
        LIMITS.maxBlankLines,
        DEFAULTS.maxBlankLines
      ),
      wrapLineLength: clampInteger(
        source.wrapLineLength,
        LIMITS.wrapLineLength,
        DEFAULTS.wrapLineLength
      ),
    };
  }

  let current = normalize(DEFAULTS);

  function configure(style) {
    current = normalize(style);
  }

  function indentUnit() {
    return current.indentTabs ? "\t" : " ".repeat(current.indentSize);
  }

  // True when more than half of `text` is on lines longer than MINIFIED_LINE_LENGTH.
  function looksMinified(text) {
    const length = text.length;
    if (length < MINIFIED_LINE_LENGTH) return false;
    let longChars = 0;
    let start = 0;
    while (start < length) {
      let end = text.indexOf("\n", start);
      if (end === -1) end = length;
      if (end - start > MINIFIED_LINE_LENGTH) longChars += end - start;
      start = end + 1;
    }
    return longChars * 2 > length;
  }

  function braceStyleFor(content) {
    if (current.braceStyle === "auto") return looksMinified(content) ? "collapse" : "inline";
    return current.braceStyle;
  }

  // Options for js-beautify's js/css/html functions. HTML hands its inline <script> and <style> the
  // same options, so the JavaScript ones are set for every language.
  function beautifyOptions(content) {
    return {
      indent_size: current.indentSize,
      indent_with_tabs: current.indentTabs,
      end_with_newline: true,
      preserve_newlines: current.preserveBlankLines,
      max_preserve_newlines: current.maxBlankLines + 1,
      wrap_line_length: current.wrapLineLength,
      keep_array_indentation: current.keepArrayLayout,
      brace_style: BEAUTIFY_BRACE_STYLES[braceStyleFor(content)],
    };
  }

  return {
    BRACE_STYLES,
    LIMITS,
    DEFAULTS,
    normalize,
    configure,
    indentUnit,
    looksMinified,
    beautifyOptions,
  };
})();
