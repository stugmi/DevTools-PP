// Behavioral tests for the source filter pattern language and file type grouping.
// Run with `bun test scripts/test-source-filter.js`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const file = path.join(__dirname, "..", "src", "panel", "js", "lib", "source-filter.js");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(file, "utf8") + "\nthis.SourceFilter = SourceFilter;", context, {
  filename: "source-filter.js",
});
const SourceFilter = context.SourceFilter;

const files = {
  ago: SourceFilter.makeTarget(
    "src/components/Ago.tsx",
    ["https://github.githubassets.com/assets/index-Ce.js"],
    "github.githubassets.com"
  ),
  react: SourceFilter.makeTarget(
    "node_modules/react/index.js",
    ["https://github.githubassets.com/assets/vendor.js"],
    "github.githubassets.com"
  ),
  rawMin: SourceFilter.makeTarget(
    "cdn.example.com/lib/app.min.js",
    ["https://cdn.example.com/lib/app.min.js"],
    "cdn.example.com"
  ),
  css: SourceFilter.makeTarget(
    "example.com/css/Site.CSS",
    ["https://example.com/css/Site.CSS"],
    "example.com"
  ),
  font: SourceFilter.makeTarget(
    "example.com/fonts/a.woff2",
    ["https://example.com/fonts/a.woff2"],
    "example.com"
  ),
  noHost: SourceFilter.makeTarget("webpack/entry.js", [], ""),
};

function kept(options) {
  const filter = SourceFilter.createFilter(options);
  return Object.entries(files)
    .filter(([, target]) => filter.matches(target))
    .map(([name]) => name);
}

test("empty or disabled filters keep every file", () => {
  const all = Object.keys(files);
  assert.deepEqual(kept({}), all);
  assert.deepEqual(kept({ include: "  , ,\n" }), all);
  assert.deepEqual(kept({ enabled: false, include: "*.css", exclude: "react" }), all);
  assert.equal(SourceFilter.createFilter({ enabled: false, include: "x" }).active, false);
});

test("comma separated globs match file names, case-insensitively", () => {
  assert.deepEqual(kept({ include: "*.js, *.css" }), ["react", "rawMin", "css", "noHost"]);
  assert.deepEqual(kept({ include: "*.tsx" }), ["ago"]);
});

test("path globs match folders anywhere in the path", () => {
  assert.deepEqual(kept({ include: "**/node_modules/**" }), ["react"]);
  assert.deepEqual(kept({ include: "components/*.tsx" }), ["ago"]);
  assert.deepEqual(kept({ include: "src/*" }), []);
  assert.deepEqual(kept({ include: "src/**" }), ["ago"]);
});

test("plain text matches the path, a domain or a URL; a leading dot matches file name endings", () => {
  assert.deepEqual(kept({ include: "react" }), ["react"]);
  assert.deepEqual(kept({ include: "githubassets" }), ["ago", "react"]);
  assert.deepEqual(kept({ include: ".min.js" }), ["rawMin"]);
  assert.deepEqual(kept({ include: ".js" }), ["react", "rawMin", "noHost"]);
});

test("exclude removes files that include let through", () => {
  assert.deepEqual(kept({ include: "*.js", exclude: "node_modules, .min.js" }), ["noHost"]);
  assert.deepEqual(kept({ exclude: "type:image,type:font" }), [
    "ago",
    "react",
    "rawMin",
    "css",
    "noHost",
  ]);
});

test("qualifiers: ext, type, domain, path, file and url", () => {
  assert.deepEqual(kept({ include: "ext:css" }), ["css"]);
  assert.deepEqual(kept({ include: "ext:.ts*" }), ["ago"]);
  assert.deepEqual(kept({ include: "type:font|style" }), ["css", "font"]);
  assert.deepEqual(kept({ include: "type:ts" }), ["ago"]);
  assert.deepEqual(kept({ include: "domain:githubassets.com" }), ["ago", "react"]);
  assert.deepEqual(kept({ include: "domain:https://cdn.example.com/x" }), ["rawMin"]);
  assert.deepEqual(kept({ include: "domain:*.example.com" }), ["rawMin"]);
  assert.deepEqual(kept({ include: "path:src/components" }), ["ago"]);
  assert.deepEqual(kept({ include: "file:ago" }), ["ago"]);
  assert.deepEqual(kept({ include: "url:https://cdn.example.com/*" }), ["rawMin"]);
  assert.deepEqual(kept({ include: "https://example.com/*" }), ["css", "font"]);
});

test("domain matches the host or its subdomains, never a lookalike suffix", () => {
  const lookalike = SourceFilter.makeTarget("a.js", [], "notgithub.com");
  const filter = SourceFilter.createFilter({ include: "domain:github.com" });
  assert.equal(filter.matches(lookalike), false);
  assert.equal(filter.matches(SourceFilter.makeTarget("a.js", [], "gist.github.com")), true);
  assert.equal(filter.matches(SourceFilter.makeTarget("a.js", [], "github.com")), true);
});

test("regex rules use /body/flags, may contain commas, and are case-insensitive by default", () => {
  assert.deepEqual(kept({ include: "/\\.(css|woff2)$/" }), ["css", "font"]);
  assert.deepEqual(kept({ include: "/a{1,2}go/" }), ["ago"]);
  assert.deepEqual(kept({ include: "/REACT/" }), ["react"]);
  assert.deepEqual(kept({ include: "/REACT/u" }), []);
  assert.deepEqual(kept({ include: "/components/, *.css" }), ["ago", "css"]);
});

test("invalid rules are reported and ignored instead of hiding everything", () => {
  const filter = SourceFilter.createFilter({
    include: "/(/, type:nope, ext:, *.css",
    exclude: "domain:",
  });
  assert.equal(filter.includeErrors.length, 3);
  assert.equal(filter.excludeErrors.length, 1);
  assert.equal(filter.hasErrors, true);
  assert.equal(filter.matches(files.css), true);
  assert.equal(filter.matches(files.ago), false);
  assert.match(filter.includeErrors[1].message, /Unknown file type/);
});

test("only invalid rules leave the filter inactive", () => {
  const filter = SourceFilter.createFilter({ include: "/(/" });
  assert.equal(filter.active, false);
  assert.equal(filter.matches(files.ago), true);
});

test("file types come from the extension", () => {
  assert.equal(SourceFilter.typeOf("a/b.TSX"), "ts");
  assert.equal(SourceFilter.typeOf("a/b.mjs"), "js");
  assert.equal(SourceFilter.typeOf("a/b.map"), "data");
  assert.equal(SourceFilter.typeOf("a/Makefile"), "other");
  assert.equal(SourceFilter.typeOf("a/.gitignore"), "other");
  assert.equal(SourceFilter.typeLabel("style"), "Styles");
});

test("toggleToken adds and removes a chip rule without touching others", () => {
  assert.equal(SourceFilter.toggleToken("", "type:js"), "type:js");
  assert.equal(SourceFilter.toggleToken("*.css", "type:js"), "*.css, type:js");
  assert.equal(SourceFilter.toggleToken("*.css, TYPE:js", "type:js"), "*.css");
  assert.equal(SourceFilter.toggleToken("/a,b/, x", "x"), "/a,b/");
  assert.equal(SourceFilter.hasToken("*.css, type:js", "TYPE:JS"), true);
  assert.equal(SourceFilter.hasToken("*.css", "type:js"), false);
});
