// Behavioral tests for the request list selection owner (src/panel/js/core/request-selection.js).
// Run with `bun test tests/test-request-selection.js`. Each test loads the real source into a
// fresh vm context with its own state object.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "core", "request-selection.js"),
  "utf8"
);

const PATHS = ["a", "b", "c", "d", "e"];

function load(paths = PATHS) {
  const context = vm.createContext({});
  const { state, RequestSelection } = vm.runInContext(
    `const state = {
      requestTree: {},
      requestSelection: { anchor: null, paths: new Set() },
      listSelection: { network: null, files: { path: "src/app.js", section: "raw" } },
      selectedPath: "detail/doc",
      selectedSection: "headers",
    };
    ${source}
    ({ state, RequestSelection });`,
    context
  );
  for (const p of paths) state.requestTree[p] = { id: p };
  return { state, RequestSelection };
}

function rows(state, order) {
  return order.map((p) => [p, state.requestTree[p]]);
}

function selected(state) {
  return Array.from(state.requestSelection.paths);
}

function paths(entries) {
  return Array.from(entries, ([p]) => p);
}

test("selectOnly replaces a multi-selection and toggle keeps detail and files selection", () => {
  const { state, RequestSelection } = load();
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("c");
  assert.deepEqual(selected(state), ["a", "c"]);
  RequestSelection.selectOnly("b");
  assert.deepEqual(selected(state), ["b"]);
  RequestSelection.toggle("d");
  RequestSelection.toggle("b");
  assert.deepEqual(selected(state), ["d"]);
  assert.equal(RequestSelection.focusedPath(), "b");
  assert.equal(state.requestSelection.anchor, "b");
  assert.equal(state.selectedPath, "detail/doc");
  assert.equal(state.selectedSection, "headers");
  assert.deepEqual({ ...state.listSelection.files }, { path: "src/app.js", section: "raw" });
});

test("Shift range follows the supplied reordered and filtered rows", () => {
  const { state, RequestSelection } = load();
  const visible = rows(state, ["e", "c", "a", "d"]);
  RequestSelection.selectOnly("e");
  RequestSelection.selectRange("a", visible);
  assert.deepEqual(selected(state), ["e", "c", "a"]);
  RequestSelection.selectRange("d", visible);
  assert.deepEqual(selected(state), ["e", "c", "a", "d"]);
  assert.equal(RequestSelection.focusedPath(), "d");
  assert.equal(state.requestSelection.anchor, "e");
  RequestSelection.selectRange("c", visible);
  assert.deepEqual(selected(state), ["e", "c"]);
  // A target the filter hides changes nothing.
  RequestSelection.selectRange("b", visible);
  assert.deepEqual(selected(state), ["e", "c"]);
  assert.equal(RequestSelection.focusedPath(), "c");
  assert.equal(state.selectedPath, "detail/doc");
});

test("additive Shift range keeps other selected rows and the anchor", () => {
  const { state, RequestSelection } = load();
  const visible = rows(state, PATHS);
  RequestSelection.selectOnly("e");
  RequestSelection.toggle("a");
  RequestSelection.selectRange("c", visible, true);
  assert.deepEqual(selected(state).sort(), ["a", "b", "c", "e"]);
  assert.equal(state.requestSelection.anchor, "a");
  RequestSelection.selectRange("b", visible);
  assert.deepEqual(selected(state), ["a", "b"]);
});

test("hidden selected paths stay stored but batch queries exclude them", () => {
  const { state, RequestSelection } = load();
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("b");
  RequestSelection.toggle("c");
  const filtered = rows(state, ["c", "d", "a"]);
  assert.deepEqual(paths(RequestSelection.selectedVisibleEntries(filtered)), ["c", "a"]);
  assert.deepEqual(paths(RequestSelection.targetsFor("a", filtered)), ["c", "a"]);
  assert.deepEqual(selected(state), ["a", "b", "c"]);
  assert.deepEqual(paths(RequestSelection.selectedVisibleEntries(rows(state, PATHS))), [
    "a",
    "b",
    "c",
  ]);
});

test("targetsFor uses the selection for a selected path and only the clicked path outside it", () => {
  const { state, RequestSelection } = load();
  const visible = rows(state, ["d", "c", "b", "a"]);
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("c");
  const inside = RequestSelection.targetsFor("a", visible);
  assert.deepEqual(paths(inside), ["c", "a"]);
  assert.equal(inside[0][1], state.requestTree.c);
  const outside = RequestSelection.targetsFor("d", visible);
  assert.deepEqual(paths(outside), ["d"]);
  assert.equal(outside[0][1], state.requestTree.d);
  assert.deepEqual(selected(state), ["a", "c"]);
  assert.deepEqual(paths(RequestSelection.targetsFor("zzz", visible)), []);

  RequestSelection.selectOnly("b");
  assert.deepEqual(paths(inside), ["c", "a"]);
  assert.notEqual(
    RequestSelection.targetsFor("b", visible),
    RequestSelection.targetsFor("b", visible)
  );
});

test("focus keeps a selection containing the path and otherwise selects only it", () => {
  const { state, RequestSelection } = load();
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("b");
  RequestSelection.focus("a");
  assert.deepEqual(selected(state), ["a", "b"]);
  assert.equal(RequestSelection.focusedPath(), "a");
  RequestSelection.focus("e");
  assert.deepEqual(selected(state), ["e"]);
  assert.equal(RequestSelection.focusedPath(), "e");
});

test("prune drops removed requests from paths, anchor and focus", () => {
  const { state, RequestSelection } = load();
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("b");
  RequestSelection.toggle("c");
  delete state.requestTree.c;
  RequestSelection.prune();
  assert.deepEqual(selected(state), ["a", "b"]);
  assert.equal(state.requestSelection.anchor, null);
  assert.equal(RequestSelection.focusedPath(), null);
  delete state.requestTree.a;
  delete state.requestTree.b;
  assert.deepEqual(paths(RequestSelection.selectedVisibleEntries(rows(state, ["d"]))), []);
  assert.deepEqual(selected(state), []);
});

test("replacing the selection store on reset discards old selection state", () => {
  const { state, RequestSelection } = load();
  RequestSelection.selectOnly("a");
  RequestSelection.toggle("b");
  const old = state.requestSelection;
  state.requestSelection = { anchor: null, paths: new Set() };
  state.listSelection = { network: null, files: null };
  state.requestTree = { a: { id: "new-a" }, x: { id: "x" } };
  assert.equal(RequestSelection.isSelected("a"), false);
  assert.deepEqual(paths(RequestSelection.targetsFor("a", rows(state, ["a", "x"]))), ["a"]);
  RequestSelection.selectRange("x", rows(state, ["a", "x"]));
  assert.deepEqual(selected(state), ["x"]);
  RequestSelection.toggle("a");
  assert.deepEqual(selected(state), ["x", "a"]);
  assert.deepEqual(Array.from(old.paths), ["a", "b"]);
});
