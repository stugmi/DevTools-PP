// Bun's linter reads this flat config. Panel scripts get per-file globals from
// the other panel scripts' top-level declarations (see panelScriptConfigs).

const fs = require("node:fs");
const path = require("node:path");
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        chrome: "readonly",
      },
    },
    rules: {
      "no-var": "error",
      "prefer-const": "warn",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/devtools/**/*.js", "src/panel/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        JSZip: "readonly",
        beautifier: "readonly",
        SourceEditor: "readonly",
        MonacoLoader: "readonly",
        RequestViewer: "readonly",
        PanelLayout: "readonly",
        Keybinds: "readonly",
      },
    },
  },
  ...panelScriptConfigs(),
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ignores: [
      "node_modules/**",
      "src/vendor/**",
      "dist/**",
      "out/**",
      "old/**",
      ".temp/**",
      ".claude/**",
      ".agents/**",
      "eslint.config.js",
    ],
  },
];

// The panel scripts are classic <script> tags sharing one global scope. Each
// file is linted as a script that sees every other file's top-level
// `function`/`const`/`let` as a global, so typos fail no-undef and a name
// declared in two files fails no-redeclare (a real runtime error for let/const).
// A `let` reassigned from another file must be listed in WRITABLE and needs
// `// eslint-disable-next-line prefer-const` where it is declared.
function panelScriptConfigs() {
  const WRITABLE = new Set(["panelVisible"]);
  const declaration = /^(?:async function|function|const|let) ([A-Za-z_$][\w$]*)/gm;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        files.push({
          file: path.relative(__dirname, full).split(path.sep).join("/"),
          names: [...text.matchAll(declaration)].map((m) => m[1]),
        });
      }
    }
  };
  walk(path.join(__dirname, "src", "panel", "js"));
  return files.map(({ file }) => {
    const shared = {};
    for (const other of files) {
      if (other.file === file) continue;
      for (const name of other.names) shared[name] = WRITABLE.has(name) ? "writable" : "readonly";
    }
    return {
      files: [file],
      languageOptions: { sourceType: "script", globals: shared },
      rules: {
        "no-unused-vars": [
          "warn",
          {
            vars: "local",
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
      },
    };
  });
}
