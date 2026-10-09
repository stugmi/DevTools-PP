"use strict";

// A small read-only (by default) Monaco viewer for request/response bodies:
// syntax highlighting, folding, and native text selection, without the file
// editor's find-references/navigation machinery. `mount()` should be called
// once per host element and the returned handle reused across renders --
// each call creates a real `monaco.editor.create()` instance, so mounting
// repeatedly leaks editors instead of updating one.
window.RequestViewer = (() => {
  function mount(containerEl, { readOnly = true } = {}) {
    let editor = null;
    let monacoRef = null;
    let disposed = false;
    let pending = null; // { text, language }

    function applyPending() {
      if (!pending || !editor) return;
      const { text, language } = pending;
      pending = null;
      const lang = language || "plaintext";
      const model = editor.getModel();
      if (model.getLanguageId() !== lang) monacoRef.editor.setModelLanguage(model, lang);
      if (model.getValue() !== text) model.setValue(text);
    }

    const ready = window.MonacoLoader.ready.then((monaco) => {
      if (disposed) return null;
      monacoRef = monaco;
      editor = monaco.editor.create(containerEl, {
        readOnly,
        domReadOnly: readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        folding: true,
        wordWrap: "off",
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        theme: (typeof prefs !== "undefined" && prefs.editorTheme) || "vs-dark",
        fontFamily:
          (typeof prefs !== "undefined" && prefs.editorFontFamily) ||
          "Cascadia Code, Consolas, monospace",
        fontSize: (typeof prefs !== "undefined" && prefs.editorFontSize) || 12,
        lineHeight: 19,
        stopRenderingLineAfter: -1,
        maxTokenizationLineLength: 200_000,
      });
      applyPending();
      return editor;
    });

    function setContent(text, language) {
      pending = { text: text == null ? "" : String(text), language };
      if (editor) applyPending();
    }

    function setWrap(enabled) {
      const options = { wordWrap: enabled ? "on" : "off" };
      if (editor) editor.updateOptions(options);
      else ready.then(() => editor?.updateOptions(options));
    }

    function layout() {
      editor?.layout();
    }

    function dispose() {
      disposed = true;
      editor?.dispose();
      editor = null;
    }

    return { setContent, setWrap, layout, dispose };
  }

  return { mount };
})();
