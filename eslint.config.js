const js = require("@eslint/js");
const globals = require("globals");
const prettierRecommended = require("eslint-plugin-prettier/recommended");

module.exports = [
  js.configs.recommended,
  prettierRecommended,
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
      "prettier/prettier": "error",
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
      },
    },
  },
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
      "eslint.config.js",
    ],
  },
];
