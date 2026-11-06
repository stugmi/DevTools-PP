// Small read-only Monaco viewer for request/response bodies: syntax highlighting, folding and
// native selection, without the file editor's navigation machinery.
// Loaded after monaco-loader.js. Call mount() once per host element and reuse the handle:
// each call creates a real monaco.editor.create() instance, so remounting leaks editors.

"use strict";

window.RequestViewer = (() => {
  // Mounted viewers, so a font preference change reaches every open one.
  const mounted = new Set();

  // Font options from the editor preferences; lineHeight scales with the font size.
  function fontOptions() {
    const fontSize = prefs.editorFontSize || 12;
    return {
      fontFamily: prefs.editorFontFamily || "Cascadia Code, Consolas, monospace",
      fontSize,
      lineHeight: Math.round(fontSize * 1.6),
    };
  }

  function mount(containerEl) {
    let editor = null;
    let monacoRef = null;
    let pending = null; // { text, language, resetScroll }
    let lastText = null; // text last put into the model, avoids reading it back

    function applyPending() {
      if (!pending || !editor) return;
      const { text, language, resetScroll } = pending;
      pending = null;
      const lang = language || "plaintext";
      const model = editor.getModel();
      if (model.getLanguageId() !== lang) monacoRef.editor.setModelLanguage(model, lang);
      if (lastText !== text) {
        model.setValue(text);
        lastText = text;
        if (resetScroll) editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      }
    }

    const ready = window.MonacoLoader.ready.then((monaco) => {
      monacoRef = monaco;
      editor = monaco.editor.create(containerEl, {
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        folding: true,
        wordWrap: "off",
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        theme: prefs.editorTheme || "vs-dark",
        ...fontOptions(),
        stopRenderingLineAfter: -1,
        maxTokenizationLineLength: 200_000,
      });
      applyPending();
      return editor;
    });

    // `resetScroll` scrolls to the top when the text changes (e.g. paging through a hex dump).
    function setContent(text, language, { resetScroll = false } = {}) {
      pending = { text: text == null ? "" : String(text), language, resetScroll };
      if (editor) applyPending();
    }

    function setWrap(enabled) {
      const options = { wordWrap: enabled ? "on" : "off" };
      if (editor) editor.updateOptions(options);
      else ready.then(() => editor?.updateOptions(options));
    }

    const viewer = {
      setContent,
      setWrap,
      applyPreferences() {
        editor?.updateOptions(fontOptions());
      },
    };
    mounted.add(viewer);
    return viewer;
  }

  function applyPreferences() {
    for (const viewer of mounted) viewer.applyPreferences();
  }

  return { mount, applyPreferences };
})();
