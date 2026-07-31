"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src");
const output = path.join(root, "dist");
const monacoSource = path.join(root, "node_modules", "monaco-editor", "min", "vs");
const monacoOutput = path.join(output, "vendor", "monaco", "vs");

fs.rmSync(output, { recursive: true, force: true });
if (process.argv.includes("--clean")) process.exit(0);

if (!fs.existsSync(monacoSource)) {
  throw new Error("monaco-editor missing; run npm install first");
}

fs.cpSync(source, output, {
  recursive: true,
  filter: (item) => path.basename(item) !== "Thumbs.db",
});
fs.cpSync(monacoSource, monacoOutput, { recursive: true });

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const panelPath = path.join(output, "panel", "panel.html");
const panelHtml = fs.readFileSync(panelPath, "utf8");
if (!panelHtml.includes("{{version}}")) {
  throw new Error("panel.html version placeholder is missing");
}
fs.writeFileSync(panelPath, panelHtml.replace("{{version}}", packageJson.version));

const workerMap = {
  editor: "../vendor/monaco/vs/base/worker/workerMain.js",
  json: "../vendor/monaco/vs/base/worker/workerMain.js",
  css: "../vendor/monaco/vs/base/worker/workerMain.js",
  html: "../vendor/monaco/vs/base/worker/workerMain.js",
  typescript: "../vendor/monaco/vs/base/worker/workerMain.js",
};
for (const [label, workerPath] of Object.entries(workerMap)) {
  const builtPath = path.resolve(path.join(output, "panel"), workerPath);
  if (!fs.existsSync(builtPath)) throw new Error(`Monaco ${label} worker missing`);
}
fs.writeFileSync(
  path.join(output, "vendor", "monaco", "worker-map.js"),
  `window.MONACO_WORKERS = ${JSON.stringify(workerMap, null, 2)};\n`
);

const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
if (!manifest.devtools_page || !fs.existsSync(path.join(output, manifest.devtools_page))) {
  throw new Error("built manifest points at a missing DevTools page");
}

console.log(`Built extension ${manifest.version} in ${path.relative(root, output)}`);
