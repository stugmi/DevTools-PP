"use strict";

// Source editor: Monaco instance for the file view, TypeScript project setup for authored
// files, and go-to-definition / references navigation across captured documents.
// Loaded after monaco-loader.js and keybinds.js; search.js wires in the workspace callbacks.
window.SourceEditor = (() => {
  let editor = null;
  let workspace = null;
  let current = null;
  let suppressChanges = false;
  const modelMeta = new Map();
  const disposables = [];
  // URIs of models this module created (not the authored project's); disposed on tab close,
  // on capture reset, and when no open tab needs them any more.
  const ownedUris = new Set();
  // Models created for the last Find References result; kept so the peek view can show them.
  let referenceUris = new Set();
  let pendingEdit = false;
  let editTimer = null;
  let forcedReadOnly = false;
  let readOnlyBeforeForce = false;
  // Cursor, selection and scroll per document id, so showing a document again (workspace or
  // tab switch) lands where the user or a navigation left it.
  const viewStates = new Map();

  function saveViewState() {
    if (!editor || !current || !editor.getModel()) return;
    const view = editor.saveViewState();
    if (view) viewStates.set(current.id, view);
  }

  const EDIT_SYNC_MS = 150;
  const MAX_REFERENCE_LOCATIONS = 1000;
  const MAX_REFERENCE_DOCUMENTS = 200;
  const DEFINITION_WINDOW = 200_000;

  const DEFAULT_APPEARANCE = {
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: 12,
    theme: "vs-dark",
    smoothScrolling: false,
  };

  // Monaco's own auto scaling is disabled by a fixed lineHeight, so derive it from the size.
  // RequestViewer uses the same formula.
  function lineHeightFor(fontSize) {
    return Math.round(fontSize * 1.6);
  }

  const THEME_IDS = window.MonacoLoader.THEME_IDS;

  const ready = window.MonacoLoader.ready.then((monaco) => {
    editor = monaco.editor.create(document.getElementById("editor-container"), {
      theme: DEFAULT_APPEARANCE.theme,
      automaticLayout: true,
      fontFamily: DEFAULT_APPEARANCE.fontFamily,
      fontSize: DEFAULT_APPEARANCE.fontSize,
      lineHeight: lineHeightFor(DEFAULT_APPEARANCE.fontSize),
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
      if (suppressChanges || !current || !workspace || current.readOnly) return;
      pendingEdit = true;
      clearTimeout(editTimer);
      editTimer = setTimeout(flushEdit, EDIT_SYNC_MS);
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

  // Sends the pending edit (one getValue() per burst of typing, not per keystroke).
  function flushEdit() {
    clearTimeout(editTimer);
    if (!pendingEdit) return;
    pendingEdit = false;
    const model = editor?.getModel();
    if (!model || !current || !workspace || current.readOnly) return;
    workspace.onChange(current, model.getValue(), {
      lines: model.getLineCount(),
      length: model.getValueLength(),
    });
  }

  // Replaces the model text without reporting it as a user edit.
  function setModelText(model, text) {
    const previous = suppressChanges;
    suppressChanges = true;
    try {
      model.setValue(text);
    } finally {
      suppressChanges = previous;
    }
  }

  function ensureModel(monaco, document) {
    const uri = modelUri(monaco, document);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(document.content, document.language, uri);
      if (!projectUris.has(uri.toString())) ownedUris.add(uri.toString());
    } else {
      if (model.getLanguageId() !== document.language) {
        monaco.editor.setModelLanguage(model, document.language);
      }
      if (model.getValue() !== document.content) setModelText(model, document.content);
    }
    modelMeta.set(uri.toString(), document.id);
    return model;
  }

  function disposeOwnedModel(key) {
    ownedUris.delete(key);
    referenceUris.delete(key);
    // Authored project models stay alive (and navigable) until the project sync drops them.
    if (projectUris.has(key)) return;
    modelMeta.delete(key);
    window.monaco?.editor
      .getModels()
      .find((model) => model.uri.toString() === key)
      ?.dispose();
  }

  // Disposes the models of owned documents that no open tab shows or references. The open
  // model is always kept.
  function pruneModels() {
    const open = editor?.getModel()?.uri.toString();
    for (const key of [...ownedUris]) {
      if (key === open || referenceUris.has(key) || projectUris.has(key)) continue;
      const id = modelMeta.get(key);
      if (id && workspace?.isDocumentOpen?.(id)) continue;
      disposeOwnedModel(key);
    }
  }

  // Synchronous and safe before Monaco is ready: called from tab closing.
  function disposeDocument(id) {
    if (!window.monaco) return;
    if (current?.id === id) flushEdit();
    viewStates.delete(id);
    for (const [key, documentId] of [...modelMeta]) {
      if (documentId === id && ownedUris.has(key)) disposeOwnedModel(key);
    }
  }

  // Capture reset: drop every editor-created model that is not part of the authored project.
  function disposeAllModels() {
    if (!window.monaco) return;
    clearTimeout(editTimer);
    pendingEdit = false;
    referenceUris = new Set();
    viewStates.clear();
    for (const key of [...ownedUris]) disposeOwnedModel(key);
  }

  // -- TypeScript project for source-mapped (authored) files --
  // A source map only contains the project's own files, and Monaco's TypeScript service only
  // knows the open file, so every import (even `./env`) reports "Cannot find module". Fix:
  //   1. Configure Node-style resolution, JSX and module detection.
  //   2. Register the authored files as a virtual project (file:///mapped/...) so relative
  //      imports and `src/...` aliases resolve to them.
  //   3. Declare unresolvable packages and assets as `any`, and hide the "cannot find
  //      name/module" diagnostics. They are always false positives here (no node_modules,
  //      no @types, bundler globals).
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
    flushEdit();
    const monaco = window.monaco;
    suppressChanges = true;
    let model;
    try {
      model = ensureModel(monaco, document);
      if (document.section === "mapped") {
        projectActive = true;
        if (projectDirty) syncProject(monaco);
      }
      // Transient previews (raw file links, "Loading...") are never editable.
      const readOnly = Boolean(document.readOnly);
      if (readOnly !== forcedReadOnly) {
        if (readOnly) readOnlyBeforeForce = Boolean(editor.getRawOptions().readOnly);
        editor.updateOptions({ readOnly: readOnly || readOnlyBeforeForce });
        forcedReadOnly = readOnly;
      }
      saveViewState();
      current = document;
      editor.setModel(model);
    } finally {
      suppressChanges = false;
    }
    pruneModels();
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
    } else {
      const view = viewStates.get(document.id);
      if (view) editor.restoreViewState(view);
    }
    editor.focus();
    return model;
  }

  async function hide() {
    await ready;
    flushEdit();
    saveViewState();
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

  // Toggles only wordWrap (minimap stays whatever the settings say). Resolves to the new state.
  async function toggleWrap() {
    await ready;
    const enabled = !(await isWrapEnabled());
    editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
    return enabled;
  }

  async function isWrapEnabled() {
    await ready;
    return editor.getOption(window.monaco.editor.EditorOption.wordWrap) !== "off";
  }

  async function applyPreferences(preferences = {}) {
    await ready;
    const options = {};
    if (preferences.fontFamily) options.fontFamily = preferences.fontFamily;
    if (preferences.fontSize) {
      options.fontSize = Number(preferences.fontSize);
      options.lineHeight = lineHeightFor(options.fontSize);
    }
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
    // Only the last DEFINITION_WINDOW characters before the cursor are scanned, so hover and
    // go-to-definition stay responsive in multi-MB bundles.
    const windowStart = Math.max(0, cursorOffset - DEFINITION_WINDOW);
    const startPosition = model.getPositionAt(windowStart);
    const before = model.getValueInRange(
      new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        position.lineNumber,
        position.column
      )
    );
    const escaped = escapeRegExp(word);
    const patterns = [
      new RegExp(
        `\\b(?:const|let|var|function|class|interface|type|enum)\\s+(${escaped})(?![\\w$])`,
        "g"
      ),
      // Bounded and quote-free so it cannot run on into the next statement of a bundle.
      new RegExp(
        `\\bimport\\s+(?:[^;'"]{0,400}?\\b)?(${escaped})(?![\\w$])(?=[\\s,}]*from\\b)`,
        "g"
      ),
      new RegExp(`(?:^|[;{}])\\s*(${escaped})\\s*=(?!=|>)`, "gm"),
      new RegExp(`(?<![.\\w$])(${escaped})\\s*=(?!=|>)`, "g"),
      new RegExp(
        `\\bfunction(?:\\s+[\\w$]+)?\\s*\\([^)]{0,500}?(?:^|[,\\s])(${escaped})(?![\\w$])[^)]*\\)`,
        "g"
      ),
    ];
    let best = null;
    for (const pattern of patterns) {
      for (const match of before.matchAll(pattern)) {
        const offset = windowStart + match.index + match[0].lastIndexOf(word);
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
        if (!Keybinds.matches(event.browserEvent, "editor.goToDefinition")) return;
        if (!openDefinition(monaco, editor.getModel(), editor.getPosition())) return;
        event.preventDefault();
        event.stopPropagation();
      })
    );
  }

  // Line/column of every whole-word match of `pattern` in `text`, up to `limit`, without
  // creating a model or splitting the text.
  function scanWord(text, pattern, limit) {
    const found = [];
    let line = 1;
    let lineStart = 0;
    let nextNewline = text.indexOf("\n");
    pattern.lastIndex = 0;
    let match;
    while (found.length < limit && (match = pattern.exec(text))) {
      while (nextNewline !== -1 && nextNewline < match.index) {
        line++;
        lineStart = nextNewline + 1;
        nextNewline = text.indexOf("\n", lineStart);
      }
      found.push({ line, column: match.index - lineStart + 1 });
    }
    return found;
  }

  // Find References: scans the documents as plain strings and only creates a model for a
  // document that has matches (the peek view needs one to preview it). Capped so a common
  // word cannot create thousands of models.
  async function findReferenceLocations(monaco, word) {
    if (!workspace) return [];
    const documents = await workspace.getDocuments();
    referenceUris = new Set();
    pruneModels();
    const pattern = wordPattern(word);
    const locations = [];
    let modelDocuments = 0;
    for (let index = 0; index < documents.length; index++) {
      const full =
        locations.length >= MAX_REFERENCE_LOCATIONS || modelDocuments >= MAX_REFERENCE_DOCUMENTS;
      if (full) break;
      const document = documents[index];
      const uri = modelUri(monaco, document);
      // An existing model may show a pretty-printed version, so its text wins.
      const existing = monaco.editor.getModel(uri);
      const text = existing ? existing.getValue() : document.content;
      const found = scanWord(text, pattern, MAX_REFERENCE_LOCATIONS - locations.length);
      if (found.length) {
        let model = existing;
        if (model) {
          modelMeta.set(uri.toString(), document.id);
        } else {
          model = ensureModel(monaco, document);
          referenceUris.add(uri.toString());
          modelDocuments++;
        }
        for (const { line, column } of found) {
          locations.push({
            uri: model.uri,
            range: new monaco.Range(line, column, line, column + word.length),
          });
        }
      }
      if (index % 25 === 24) await new Promise((resolve) => setTimeout(resolve));
    }
    return locations;
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
      provideReferences(model, position) {
        const word = model.getWordAtPosition(position)?.word;
        if (!word) return [];
        return findReferenceLocations(monaco, word);
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
    isWrapEnabled,
    applyPreferences,
    disposeDocument,
    disposeAllModels,
  };
})();
