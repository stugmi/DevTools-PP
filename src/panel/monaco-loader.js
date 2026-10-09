"use strict";

// Shared Monaco bootstrap: the AMD loader config, worker environment, and
// custom theme definitions used by both the interactive file editor
// (editor.js -> SourceEditor) and the read-only request/response viewers
// (request-viewer.js -> RequestViewer). Loaded once; both consumers create
// their own `monaco.editor.create()` instance against the resolved `monaco`
// namespace this exposes.
window.MonacoLoader = (() => {
  // Themes selectable by the user. "source-exporter*" entries are custom
  // themes defined below; the rest are Monaco's built-in themes.
  const THEME_IDS = new Set([
    "vs-dark",
    "devtools",
    "source-exporter",
    "vs",
    "source-exporter-light",
    "hc-black",
    "hc-light",
  ]);

  const ready = new Promise((resolve, reject) => {
    if (typeof window.require !== "function") {
      reject(new Error("Monaco loader unavailable"));
      return;
    }
    window.require.config({ paths: { vs: "../vendor/monaco/vs" } });
    window.require(
      ["vs/editor/editor.main"],
      () => {
        const monaco = window.monaco;
        const workerPaths = window.MONACO_WORKERS;
        self.MonacoEnvironment ||= {};
        self.MonacoEnvironment.getWorker = (_moduleId, label) => {
          const kind =
            label === "json"
              ? "json"
              : label === "css" || label === "scss" || label === "less"
                ? "css"
                : label === "html" || label === "handlebars" || label === "razor"
                  ? "html"
                  : label === "typescript" || label === "javascript"
                    ? "typescript"
                    : "editor";
          return new Worker(new URL(workerPaths[kind], window.location.href), { name: label });
        };
        monaco.editor.defineTheme("source-exporter", {
          base: "vs-dark",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": "#0f1419",
            "editor.foreground": "#c9d1d9",
            "editorLineNumber.foreground": "#3f4b57",
            "editorLineNumber.activeForeground": "#7aa0c4",
            "editor.selectionBackground": "#264f78",
            "editorWidget.background": "#171d23",
            "editorWidget.border": "#33404d",
          },
        });

        monaco.editor.defineTheme("devtools", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "keyword", foreground: "#ec719a" },
            { token: "storage", foreground: "#ec719a" },
            { token: "storage.type", foreground: "#ec719a" },
            { token: "string", foreground: "#5bb974" },
            { token: "comment", foreground: "#80868b", fontStyle: "italic" },
            { token: "number", foreground: "#8ab4f8" },
            { token: "tag", foreground: "#ec719a" },
            { token: "attribute.name", foreground: "#fdd663" },
            { token: "attribute.value", foreground: "#5bb974" },
            { token: "type", foreground: "#78d9ec" },
            { token: "identifier", foreground: "#e8eaed" },
            { token: "delimiter", foreground: "#e8eaed" },
          ],
          colors: {
            "editor.background": "#202124",
            "editor.foreground": "#e8eaed",
            "editorLineNumber.foreground": "#5f6368",
            "editorLineNumber.activeForeground": "#e8eaed",
            "editor.selectionBackground": "#394459",
            "editor.lineHighlightBackground": "#28292c",
            "editorWidget.background": "#292a2d",
            "editorWidget.border": "#3c4043",
            "sideBar.background": "#292a2d",
            "sideBar.border": "#3c4043",
            "tab.activeBackground": "#202124",
            "tab.inactiveBackground": "#292a2d",
            "tab.activeBorder": "#8ab4f8",
            "statusBar.background": "#202124",
            "statusBar.border": "#3c4043",
          },
        });
        monaco.editor.defineTheme("source-exporter-light", {
          base: "vs",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": "#ffffff",
            "editor.foreground": "#1f2328",
            "editorLineNumber.foreground": "#8c959f",
            "editorLineNumber.activeForeground": "#1a73a8",
            "editor.selectionBackground": "#c8dffa",
            "editorWidget.background": "#f6f8fa",
            "editorWidget.border": "#d0d7de",
          },
        });
        monaco.languages.typescript?.javascriptDefaults?.setEagerModelSync(true);
        monaco.languages.typescript?.typescriptDefaults?.setEagerModelSync(true);
        resolve(monaco);
      },
      reject
    );
  });

  return { ready, THEME_IDS };
})();
