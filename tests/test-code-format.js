// Behavioral tests for the code formatting style: how the stored options become js-beautify
// options, and what the beautifier produces for already-formatted and minified code.
// Run with `bun test tests/test-code-format.js`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const beautify = require("js-beautify");

const file = path.join(__dirname, "..", "src", "panel", "js", "lib", "code-format.js");

// Each test gets a fresh copy so the module's current style never leaks between tests.
function loadCodeFormat() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, "utf8") + "\nthis.CodeFormat = CodeFormat;", context, {
    filename: "code-format.js",
  });
  return context.CodeFormat;
}

const formatted = `import {isFeatureEnabled} from '@github-ui/feature-flags'
import {Truncate, Link, RelativeTime} from '@primer/react'

const timeIntervals = [
  {unit: 'month', ms: month},
  {unit: 'day', ms: day},
]
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
})
function f({a, b}) {
  const {x, y} = a
  return x
}
`;

const minified =
  "var a=function(e,t){if(e){return{a:1,b:2}}for(var n=0;n<t;n++){console.log(n)}return e&&t?function(){return 1}:{x:1,y:{z:2}}};".repeat(
    4
  );

test("smart style keeps already-formatted imports and short objects on one line", () => {
  const codeFormat = loadCodeFormat();
  const out = beautify.js(formatted, codeFormat.beautifyOptions(formatted));
  assert.match(out, /^import \{ ?isFeatureEnabled ?\} from '@github-ui\/feature-flags'$/m);
  assert.match(out, /^import \{ ?Truncate, Link, RelativeTime ?\} from '@primer\/react'$/m);
  assert.match(out, /^ {2}\{ ?unit: 'month', ms: month ?\},$/m);
  assert.match(out, /^function f\(\{ ?a, b ?\}\) \{$/m);
  assert.match(out, /^ {2}year: 'numeric',$/m);
});

test("smart style fully expands minified code", () => {
  const codeFormat = loadCodeFormat();
  assert.equal(codeFormat.looksMinified(minified), true);
  const out = beautify.js(minified, codeFormat.beautifyOptions(minified));
  assert.match(out, /^ {4}return \{$/m);
  assert.match(out, /^ {6}a: 1,$/m);
});

test("a formatted file with one long data line is not treated as minified", () => {
  const codeFormat = loadCodeFormat();
  const text = formatted + "const blob = '" + "x".repeat(400) + "'\n" + formatted.repeat(5);
  assert.equal(codeFormat.looksMinified(text), false);
});

test("collapse always expands, inline always keeps, expand moves braces to their own line", () => {
  const codeFormat = loadCodeFormat();
  const render = (braceStyle, code) => {
    codeFormat.configure({ braceStyle });
    return beautify.js(code, codeFormat.beautifyOptions(code));
  };
  assert.match(render("collapse", formatted), /^import \{$/m);
  assert.doesNotMatch(render("inline", minified), /\n {4}return \{\n/);
  assert.match(render("expand", "if(x){y()}"), /^if \(x\)\n\{$/m);
});

test("indent, blank-line and wrap options reach the beautifier", () => {
  const codeFormat = loadCodeFormat();
  const code = "if(x){\ny()\n}\n\n\n\nz()\n";
  codeFormat.configure({ indentTabs: true });
  assert.match(beautify.js(code, codeFormat.beautifyOptions(code)), /^\ty\(\)$/m);
  assert.equal(codeFormat.indentUnit(), "\t");

  codeFormat.configure({ indentSize: 4, maxBlankLines: 2 });
  const out = beautify.js(code, codeFormat.beautifyOptions(code));
  assert.match(out, /^ {4}y\(\)$/m);
  assert.match(out, /\}\n\n\nz\(\)/);
  assert.equal(codeFormat.indentUnit(), "    ");

  codeFormat.configure({ preserveBlankLines: false });
  assert.doesNotMatch(beautify.js(code, codeFormat.beautifyOptions(code)), /\n\n/);

  codeFormat.configure({ wrapLineLength: 30 });
  const wrapped = beautify.js("call(argumentNumberOne, argumentNumberTwo, argumentNumberThree)", {
    ...codeFormat.beautifyOptions(""),
  });
  assert.ok(wrapped.split("\n").length > 1);
});

test("normalize clamps stored values and falls back to defaults", () => {
  const codeFormat = loadCodeFormat();
  const style = codeFormat.normalize({
    indentSize: "99",
    maxBlankLines: -3,
    wrapLineLength: "abc",
    braceStyle: "nope",
    indentTabs: "yes",
  });
  assert.equal(style.indentSize, 8);
  assert.equal(style.maxBlankLines, 0);
  assert.equal(style.wrapLineLength, 0);
  assert.equal(style.braceStyle, "auto");
  assert.equal(style.indentTabs, false);
  assert.deepEqual({ ...codeFormat.normalize(null) }, { ...codeFormat.DEFAULTS });
});
