"use strict";

window.SourceEditor = (() => {
  let editor = null;
  let workspace = null;
  let current = null;
  let suppressChanges = false;
  const modelMeta = new Map();
  const disposables = [];

  const DEFAULT_APPEARANCE = {
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: 12,
    theme: "vs-dark",
    smoothScrolling: false,
  };

  const THEME_IDS = window.MonacoLoader.THEME_IDS;

  const ready = window.MonacoLoader.ready.then((monaco) => {
    editor = monaco.editor.create(document.getElementById("editor-container"), {
      theme: DEFAULT_APPEARANCE.theme,
      automaticLayout: true,
      fontFamily: DEFAULT_APPEARANCE.fontFamily,
      fontSize: DEFAULT_APPEARANCE.fontSize,
      lineHeight: 19,
      minimap: { enabled: true },
      wordWrap: "off",
      scrollBeyondLastLine: false,
      smoothScrolling: DEFAULT_APPEARANCE.smoothScrolling,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      fixedOverflowWidgets: true,
      // Large single-line JSON/JS payloads (e.g. hydration data inside a
      // <script> tag) are common in captured sources. Monaco's defaults
      // (10k render / 20k tokenize) silently drop syntax highlighting
      // past those lengths for *any* language, so raise them well beyond
      // typical embedded JSON blobs.
      stopRenderingLineAfter: -1,
      maxTokenizationLineLength: 200_000,
    });
    editor.onDidChangeModelContent(() => {
      if (!suppressChanges && current && workspace) {
        workspace.onChange(current, editor.getValue());
      }
    });
    configureTypeScript(monaco);
    registerLanguageProviders(monaco);
    registerNavigation(monaco);
    return editor;
  });

  function configure(callbacks) {
    workspace = callbacks;
  }

  function modelUri(monaco, document) {
    const safeSection = encodeURIComponent(document.section);
    const safePath = document.path
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    // file:/// so the TypeScript service can resolve imports between models.
    return monaco.Uri.parse(`file:///${safeSection}/${safePath}`);
  }

  function ensureModel(monaco, document) {
    const uri = modelUri(monaco, document);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(document.content, document.language, uri);
    } else {
      if (model.getLanguageId() !== document.language) {
        monaco.editor.setModelLanguage(model, document.language);
      }
      if (model.getValue() !== document.content) model.setValue(document.content);
    }
    modelMeta.set(uri.toString(), document.id);
    return model;
  }

  // ── TypeScript project for source-mapped (authored) files ───────────────
  //
  // A source map only contains the project's own files. Out of the box,
  // Monaco's TypeScript service has no module resolution configured and only
  // knows about the one file that is open, so every import -- even `./env`
  // next to it -- is reported as "Cannot find module". To fix that:
  //   1. configure Node-style resolution, JSX and module detection,
  //   2. register the authored files as a virtual project (file:///mapped/...)
  //      so relative imports and `src/...`-style aliases resolve to them,
  //   3. declare unresolvable packages/assets as `any` and hide the
  //      "cannot find name/module" family of diagnostics, which are always
  //      false positives here (no node_modules, no @types, bundler globals).
  const AMBIENT_LIB = [
    "declare module '*';",
    "declare var process: any;",
    "declare var require: any;",
    "declare var module: any;",
    "declare var exports: any;",
    "declare var global: any;",
    "declare var __dirname: string;",
    "declare var __filename: string;",
    "declare var __webpack_require__: any;",
    "declare var __webpack_public_path__: string;",
  ].join("\n");

  // 2307/2792/7016: unresolved module / missing declaration file.
  // 2304/2580/2591/2503: unknown name / namespace (bundler-injected globals).
  // 2686/7026/2875: JSX without React in scope / intrinsic elements / runtime.
  const IGNORED_DIAGNOSTICS = [2307, 2792, 7016, 2304, 2580, 2591, 2503, 2686, 7026, 2875];
  const PROJECT_MAX_FILES = 1500;
  const PROJECT_MAX_BYTES = 400_000;

  let diagnosticsMode = "smart";
  let projectRoots = [""];
  let projectActive = false;
  let projectDirty = true;
  let projectTimer = null;
  let projectUris = new Set();

  function applyCompilerOptions(monaco) {
    const ts = monaco.languages.typescript;
    if (!ts) return;
    const options = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      // 3 = "force": every file is a module, so files that happen to have no
      // import/export don't leak declarations into one shared global scope.
      moduleDetection: 3,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: "file:///mapped",
      paths: { "*": projectRoots.map((root) => `${root}*`) },
    };
    ts.typescriptDefaults.setCompilerOptions(options);
    ts.javascriptDefaults.setCompilerOptions(options);
  }

  function applyDiagnostics(monaco) {
    const ts = monaco.languages.typescript;
    if (!ts) return;
    const off = diagnosticsMode === "off";
    ts.typescriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: off,
      noSemanticValidation: off || diagnosticsMode === "syntax",
      noSuggestionDiagnostics: off,
      diagnosticCodesToIgnore: IGNORED_DIAGNOSTICS,
    });
    ts.javascriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: off,
      noSemanticValidation: true,
      noSuggestionDiagnostics: off,
    });
  }

  function configureTypeScript(monaco) {
    const ts = monaco.languages.typescript;
    if (!ts) return;
    applyCompilerOptions(monaco);
    ts.typescriptDefaults.addExtraLib(AMBIENT_LIB, "file:///ambient/bundler-globals.d.ts");
    ts.javascriptDefaults.addExtraLib(AMBIENT_LIB, "file:///ambient/bundler-globals.d.ts");
    applyDiagnostics(monaco);
  }

  // Source-map paths usually carry a project-name prefix (`app/src/env.ts`)
  // while code imports `src/env`. Work out which prefixes to try so bare
  // specifiers resolve: the root itself, whatever precedes a `src/` folder,
  // and the single shared top-level folder if there is one.
  function computeProjectRoots(paths) {
    const roots = new Set([""]);
    const top = new Set();
    for (const path of paths) {
      const parts = path.split("/");
      top.add(parts[0]);
      const at = parts.indexOf("src");
      if (at > 0) roots.add(parts.slice(0, at).join("/") + "/");
    }
    if (top.size === 1 && paths.some((path) => path.includes("/"))) roots.add([...top][0] + "/");
    return [...roots].sort();
  }

  // Creates models for authored files that don't have one yet. Existing models
  // are left alone on purpose: the open file may be showing a pretty-printed
  // version that differs from the stored source.
  function syncProject(monaco) {
    projectDirty = false;
    if (!workspace?.getAuthoredDocuments) return;
    const docs = workspace.getAuthoredDocuments().slice(0, PROJECT_MAX_FILES);
    const roots = computeProjectRoots(docs.map((doc) => doc.path));
    if (roots.join("|") !== projectRoots.join("|")) {
      projectRoots = roots;
      applyCompilerOptions(monaco);
    }
    const wanted = new Set();
    for (const doc of docs) {
      const uri = modelUri(monaco, doc);
      const key = uri.toString();
      wanted.add(key);
      if (!monaco.editor.getModel(uri)) monaco.editor.createModel(doc.content, doc.language, uri);
      modelMeta.set(key, doc.id);
    }
    for (const key of projectUris) {
      if (wanted.has(key)) continue;
      const model = monaco.editor.getModels().find((item) => item.uri.toString() === key);
      if (model && model !== editor.getModel()) {
        modelMeta.delete(key);
        model.dispose();
      }
    }
    projectUris = wanted;
  }

  // Called whenever the captured sources change. Does nothing until an
  // authored file has actually been opened, so merely capturing a site never
  // pays for loading the whole project into the TypeScript worker.
  function scheduleProjectSync() {
    projectDirty = true;
    if (!projectActive) return;
    clearTimeout(projectTimer);
    projectTimer = setTimeout(() => {
      ready.then(() => syncProject(window.monaco)).catch(() => {});
    }, 800);
  }

  async function show(document, position) {
    await ready;
    const monaco = window.monaco;
    suppressChanges = true;
    const model = ensureModel(monaco, document);
    if (document.section === "mapped") {
      projectActive = true;
      if (projectDirty) syncProject(monaco);
    }
    current = document;
    editor.setModel(model);
    suppressChanges = false;
    if (position) {
      const lineNumber = Math.max(1, Math.min(position.line, model.getLineCount()));
      const maxColumn = model.getLineMaxColumn(lineNumber);
      const startColumn = Math.max(1, Math.min(position.column || 1, maxColumn));
      const endColumn = Math.max(
        startColumn,
        Math.min(position.endColumn || startColumn, maxColumn)
      );
      const selection = new monaco.Selection(lineNumber, startColumn, lineNumber, endColumn);
      editor.setSelection(selection);
      editor.revealRangeInCenter(selection);
    }
    editor.focus();
    return model;
  }

  async function hide() {
    await ready;
    current = null;
    editor.setModel(null);
  }

  async function focusFind() {
    await ready;
    editor.focus();
    editor.getAction("actions.find").run();
  }

  async function getSelectedText() {
    await ready;
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return "";
    return editor.getModel()?.getValueInRange(selection) ?? "";
  }

  async function findReferences() {
    await ready;
    editor.focus();
    editor.getAction("editor.action.referenceSearch.trigger").run();
  }

  async function toggleWrap(enabled) {
    await ready;
    editor.updateOptions({ wordWrap: enabled ? "on" : "off", minimap: { enabled: !enabled } });
  }

  async function applyPreferences(preferences = {}) {
    await ready;
    const options = {};
    if (preferences.fontFamily) options.fontFamily = preferences.fontFamily;
    if (preferences.fontSize) options.fontSize = Number(preferences.fontSize);
    if (preferences.tsDiagnostics && preferences.tsDiagnostics !== diagnosticsMode) {
      diagnosticsMode = preferences.tsDiagnostics;
      applyDiagnostics(window.monaco);
    }
    if (typeof preferences.smoothScrolling === "boolean") {
      options.smoothScrolling = preferences.smoothScrolling;
    }
    if (Object.keys(options).length) editor.updateOptions(options);
    if (preferences.theme && THEME_IDS.has(preferences.theme)) {
      window.monaco.editor.setTheme(preferences.theme);
    }
  }

  function escapeRegExp(value) {
    const special = "\\^$.*+?()[]{}|";
    return Array.from(value, (character) =>
      special.includes(character) ? `\\${character}` : character
    ).join("");
  }

  function wordPattern(word) {
    return new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`, "g");
  }

  function findLastDefinition(monaco, model, position) {
    const wordInfo = model.getWordAtPosition(position);
    if (!wordInfo) return null;
    const word = wordInfo.word;
    const cursorOffset = model.getOffsetAt(position);
    const before = model.getValue().slice(0, cursorOffset);
    const escaped = escapeRegExp(word);
    const patterns = [
      new RegExp(
        `\\b(?:const|let|var|function|class|interface|type|enum)\\s+(${escaped})(?![\\w$])`,
        "g"
      ),
      new RegExp(`\\bimport\\s+(?:[\\s\\S]*?\\b)?(${escaped})(?![\\w$])(?=[\\s,}]*from\\b)`, "g"),
      new RegExp(`(?:^|[;{}])\\s*(${escaped})\\s*=(?!=|>)`, "gm"),
      new RegExp(`(?<![.\\w$])(${escaped})\\s*=(?!=|>)`, "g"),
      new RegExp(
        `\\bfunction(?:\\s+[\\w$]+)?\\s*\\([^)]*?(?:^|[,\\s])(${escaped})(?![\\w$])[^)]*\\)`,
        "g"
      ),
    ];
    let best = null;
    for (const pattern of patterns) {
      for (const match of before.matchAll(pattern)) {
        const offset = match.index + match[0].lastIndexOf(word);
        if (!best || offset > best.offset) best = { offset };
      }
    }
    if (!best) return null;
    const start = model.getPositionAt(best.offset);
    return {
      uri: model.uri,
      range: new monaco.Range(
        start.lineNumber,
        start.column,
        start.lineNumber,
        start.column + word.length
      ),
    };
  }

  function openDefinition(monaco, model, position) {
    if (!model || !position) return false;
    const definition = findLastDefinition(monaco, model, position);
    if (!definition || !workspace) return false;
    const id = modelMeta.get(definition.uri.toString());
    if (!id) return false;
    workspace.openDocument(id, {
      line: definition.range.startLineNumber,
      column: definition.range.startColumn,
      endColumn: definition.range.endColumn,
    });
    return true;
  }

  function registerNavigation(monaco) {
    disposables.push(
      editor.onMouseDown((event) => {
        const browserEvent = event.event.browserEvent;
        if (!(browserEvent.ctrlKey || browserEvent.metaKey) || !event.target.position) return;
        if (!openDefinition(monaco, editor.getModel(), event.target.position)) return;
        event.event.preventDefault();
        browserEvent.stopPropagation();
      })
    );
    disposables.push(
      editor.onKeyDown((event) => {
        if (event.keyCode !== monaco.KeyCode.F12) return;
        if (!openDefinition(monaco, editor.getModel(), editor.getPosition())) return;
        event.preventDefault();
        event.stopPropagation();
      })
    );
  }

  async function getDocuments(monaco) {
    if (!workspace) return [];
    const documents = await workspace.getDocuments();
    return documents.map((document) => ({ document, model: ensureModel(monaco, document) }));
  }

  async function goToDefinition() {
    await ready;
    editor.focus();
    return openDefinition(window.monaco, editor.getModel(), editor.getPosition());
  }

  function registerLanguageProviders(monaco) {
    const languages = [
      "javascript",
      "typescript",
      "javascriptreact",
      "typescriptreact",
      "json",
      "css",
      "scss",
      "html",
    ];
    const definitionProvider = {
      provideDefinition(model, position) {
        return findLastDefinition(monaco, model, position);
      },
    };
    const referenceProvider = {
      async provideReferences(model, position) {
        const word = model.getWordAtPosition(position)?.word;
        if (!word) return [];
        const locations = [];
        for (const item of await getDocuments(monaco)) {
          const pattern = wordPattern(word);
          for (const match of item.model.getValue().matchAll(pattern)) {
            const start = item.model.getPositionAt(match.index);
            locations.push({
              uri: item.model.uri,
              range: new monaco.Range(
                start.lineNumber,
                start.column,
                start.lineNumber,
                start.column + word.length
              ),
            });
          }
        }
        return locations;
      },
    };
    const hoverProvider = {
      provideHover(model, position) {
        const word = model.getWordAtPosition(position);
        const definition = findLastDefinition(monaco, model, position);
        if (!word || !definition) return null;
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn
          ),
          contents: [
            { value: `**${word.word}**` },
            {
              value: `Last definition before cursor: line ${definition.range.startLineNumber}, column ${definition.range.startColumn}`,
            },
          ],
        };
      },
    };
    for (const language of languages) {
      disposables.push(monaco.languages.registerDefinitionProvider(language, definitionProvider));
      disposables.push(monaco.languages.registerReferenceProvider(language, referenceProvider));
      disposables.push(monaco.languages.registerHoverProvider(language, hoverProvider));
    }

    if (typeof monaco.editor.registerEditorOpener === "function") {
      disposables.push(
        monaco.editor.registerEditorOpener({
          openCodeEditor(_source, resource, selection) {
            const id = modelMeta.get(resource.toString());
            if (!id || !workspace) return false;
            workspace.openDocument(id, {
              line: selection?.startLineNumber || 1,
              column: selection?.startColumn || 1,
            });
            return true;
          },
        })
      );
    }
  }

  return {
    ready,
    configure,
    show,
    hide,
    focusFind,
    findReferences,
    goToDefinition,
    getSelectedText,
    scheduleProjectSync,
    toggleWrap,
    applyPreferences,
  };
})();
