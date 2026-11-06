// Behavioral tests for SourceMapLookup (src/panel/js/lib/source-map.js): generated -> original
// position lookup over real base64 VLQ v3 mappings. Run with `bun test scripts/test-source-map.js`.
// The panel script is a classic script, so it is evaluated in a vm context.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "lib", "source-map.js"),
  "utf8"
);
const SourceMapLookup = vm.runInContext(`${source}\nSourceMapLookup`, vm.createContext({}));
const { createSection, originalPosition, composeOffset } = SourceMapLookup;

// Independent reference encoder for the source map v3 base64 VLQ format.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}
// A segment is an array of relative deltas: [genCol] or [genCol, src, line, col(, name)].
const seg = (...fields) => fields.map(vlq).join("");
const mappings = (lines) => lines.map((segments) => segments.join(",")).join(";");

const lookup = (sections, line, column) => {
  const found = originalPosition(sections, line, column);
  return found && { key: found.key, line: found.line, column: found.column };
};
const single = (map, keys = ["a.js"]) => [createSection({ mappings: map, keys })];

test("hard-coded literal mapping decodes to exact coordinates", () => {
  // gen col 0 -> source 0, line 16, column 1 (multi-digit VLQ)
  assert.deepEqual(lookup(single("AAgBC"), 0, 0), { key: "a.js", line: 16, column: 1 });
});

test("same-line lookup picks the greatest generated column not above the query", () => {
  const map = mappings([[seg(0, 0, 0, 0), seg(5, 0, 0, 10), seg(5, 0, 2, -7)]]);
  const sections = single(map);
  // segments: col 0 -> (0,0), col 5 -> (0,10), col 10 -> (2,3)
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 0, column: 0 });
  assert.deepEqual(lookup(sections, 0, 4), { key: "a.js", line: 0, column: 0 });
  assert.deepEqual(lookup(sections, 0, 5), { key: "a.js", line: 0, column: 10 });
  assert.deepEqual(lookup(sections, 0, 9), { key: "a.js", line: 0, column: 10 });
  assert.deepEqual(lookup(sections, 0, 10), { key: "a.js", line: 2, column: 3 });
  assert.deepEqual(lookup(sections, 0, 5000), { key: "a.js", line: 2, column: 3 });
});

test("lines and columns are zero-based and generated lines are separate", () => {
  const map = mappings([[seg(0, 0, 7, 3)], [seg(2, 0, 1, 4)]]);
  const sections = single(map);
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 7, column: 3 });
  // line 1 starts its generated column at 0 again; first segment is at column 2
  assert.equal(lookup(sections, 1, 1), null);
  assert.deepEqual(lookup(sections, 1, 2), { key: "a.js", line: 8, column: 7 });
});

test("large multi-digit deltas decode exactly", () => {
  const map = mappings([[seg(300, 0, 1000, 70000)]]);
  assert.deepEqual(lookup(single(map), 0, 300), { key: "a.js", line: 1000, column: 70000 });
  assert.equal(lookup(single(map), 0, 299), null);
});

test("unmapped positions return null instead of a neighbouring guess", () => {
  const map = mappings([[seg(3, 0, 4, 4)], [], [seg(0, 0, 1, 1)]]);
  const sections = single(map);
  assert.equal(lookup(sections, 0, 2), null, "before the first segment");
  assert.deepEqual(lookup(sections, 0, 3), { key: "a.js", line: 4, column: 4 });
  assert.equal(lookup(sections, 1, 0), null, "empty line does not inherit the previous line");
  assert.equal(lookup(sections, 1, 99), null);
  assert.deepEqual(lookup(sections, 2, 0), { key: "a.js", line: 5, column: 5 });
  assert.equal(lookup(sections, 3, 0), null, "line past the end of the mappings");
  assert.equal(lookup(sections, 100, 0), null);
});

test("a one-field segment makes the following range unmapped", () => {
  const map = mappings([[seg(0, 0, 3, 3), seg(4), seg(2, 0, 0, 2)]]);
  const sections = single(map);
  assert.deepEqual(lookup(sections, 0, 3), { key: "a.js", line: 3, column: 3 });
  assert.equal(lookup(sections, 0, 4), null);
  assert.equal(lookup(sections, 0, 5), null);
  assert.deepEqual(lookup(sections, 0, 6), { key: "a.js", line: 3, column: 5 });
});

test("negative deltas move backwards and state carries across lines", () => {
  const map = mappings([
    [seg(0, 0, 5, 10)],
    [seg(0, 0, -3, -4)], // (2, 6)
    [],
    [seg(0, 0, 10, 0), seg(1, 0, -10, 20)], // (12, 6), then (2, 26)
  ]);
  const sections = single(map);
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 5, column: 10 });
  assert.deepEqual(lookup(sections, 1, 0), { key: "a.js", line: 2, column: 6 });
  assert.deepEqual(lookup(sections, 3, 0), { key: "a.js", line: 12, column: 6 });
  assert.deepEqual(lookup(sections, 3, 1), { key: "a.js", line: 2, column: 26 });
});

test("decoding a later line does not disturb earlier lines (cache is order independent)", () => {
  const map = mappings([[seg(0, 0, 1, 1)], [seg(0, 0, 1, 1)], [seg(0, 0, 1, 1)]]);
  const sections = single(map);
  assert.deepEqual(lookup(sections, 2, 0), { key: "a.js", line: 3, column: 3 });
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 1, column: 1 });
  assert.deepEqual(lookup(sections, 1, 0), { key: "a.js", line: 2, column: 2 });
  assert.deepEqual(lookup(sections, 2, 0), { key: "a.js", line: 3, column: 3 });
});

test("a delta that lands on a negative original position is unavailable", () => {
  const sections = single(mappings([[seg(0, 0, -1, 0)], [seg(0, 0, 0, -1)]]));
  assert.equal(lookup(sections, 0, 0), null);
  assert.equal(lookup(sections, 1, 0), null);
});

test("source index is a running delta and maps to the matching key", () => {
  const keys = ["a.js", null, "c.js"];
  const map = mappings([
    [seg(0, 0, 1, 1)], // source 0
    [seg(0, 1, 0, 0)], // source 1 (not retained)
    [seg(0, 1, 2, 2)], // source 2
    [seg(0, -2, 0, 0)], // back to source 0
    [seg(0, 3, 0, 0)], // source 3: out of range
    [seg(0, -4, 0, 0)], // source -1: invalid
  ]);
  const sections = single(map, keys);
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 1, column: 1 });
  assert.deepEqual(lookup(sections, 1, 0), { key: null, line: 1, column: 1 });
  assert.deepEqual(lookup(sections, 2, 0), { key: "c.js", line: 3, column: 3 });
  assert.deepEqual(lookup(sections, 3, 0), { key: "a.js", line: 3, column: 3 });
  assert.equal(lookup(sections, 4, 0), null);
  assert.equal(lookup(sections, 5, 0), null);
});

test("optional name field is accepted and does not shift later segments", () => {
  const map = mappings([[seg(0, 0, 2, 2, 5), seg(3, 0, 1, 1, -5)]]);
  const sections = single(map);
  assert.deepEqual(lookup(sections, 0, 0), { key: "a.js", line: 2, column: 2 });
  assert.deepEqual(lookup(sections, 0, 3), { key: "a.js", line: 3, column: 3 });
});

test("index map sections apply line and column offsets", () => {
  const first = createSection({
    mappings: mappings([[seg(0, 0, 0, 0)], [seg(0, 0, 1, 0)], [seg(0, 0, 1, 0)]]),
    keys: ["a.js"],
    line: 0,
    column: 0,
  });
  const second = createSection({
    mappings: mappings([[seg(0, 0, 10, 0), seg(4, 0, 0, 5)], [seg(0, 0, 1, 0)]]),
    keys: ["b.js"],
    line: 2,
    column: 5,
  });
  const sections = [first, second];

  assert.deepEqual(lookup(sections, 2, 4), { key: "a.js", line: 2, column: 0 }, "before offset");
  // generated (2,5) is the second section's (0,0)
  assert.deepEqual(lookup(sections, 2, 5), { key: "b.js", line: 10, column: 0 });
  assert.deepEqual(lookup(sections, 2, 8), { key: "b.js", line: 10, column: 0 });
  // second section's segment at its column 4 is generated column 9 on the offset line
  assert.deepEqual(lookup(sections, 2, 9), { key: "b.js", line: 10, column: 5 });
  // later lines do not get the column offset
  assert.deepEqual(lookup(sections, 3, 0), { key: "b.js", line: 11, column: 5 });
  assert.deepEqual(lookup(sections, 3, 7), { key: "b.js", line: 11, column: 5 });
});

test("positions before the first section are unmapped", () => {
  const section = createSection({
    mappings: mappings([[seg(0, 0, 0, 0)]]),
    keys: ["a.js"],
    line: 1,
    column: 3,
  });
  assert.equal(lookup([section], 0, 50), null);
  assert.equal(lookup([section], 1, 2), null);
  assert.deepEqual(lookup([section], 1, 3), { key: "a.js", line: 0, column: 0 });
});

test("a section does not leak its first-line mappings across the column offset", () => {
  const section = createSection({
    mappings: mappings([[seg(2, 0, 4, 4)]]),
    keys: ["a.js"],
    line: 0,
    column: 10,
  });
  // section column 2 is generated column 12
  assert.equal(lookup([section], 0, 11), null);
  assert.deepEqual(lookup([section], 0, 12), { key: "a.js", line: 4, column: 4 });
});

test("composeOffset nests offsets in outer generated coordinates", () => {
  assert.deepEqual({ ...composeOffset(3, 4, 0, 5) }, { line: 3, column: 9 });
  assert.deepEqual({ ...composeOffset(3, 4, 2, 5) }, { line: 5, column: 5 });
  assert.deepEqual({ ...composeOffset(0, 0, 0, 0) }, { line: 0, column: 0 });

  // A leaf nested at (1,2) inside an outer section placed at (4,6) lands at (5,2);
  // a leaf nested at (0,2) inside the same outer section lands at (4,8).
  const deep = composeOffset(4, 6, 1, 2);
  const shallow = composeOffset(4, 6, 0, 2);
  const leafMap = mappings([[seg(0, 0, 9, 9)]]);
  const sections = [
    createSection({ mappings: leafMap, keys: ["shallow.js"], ...shallow }),
    createSection({ mappings: leafMap, keys: ["deep.js"], ...deep }),
  ];
  assert.equal(lookup(sections, 4, 7), null);
  assert.deepEqual(lookup(sections, 4, 8), { key: "shallow.js", line: 9, column: 9 });
  // (5,1) is past the one-line shallow leaf and before the deep leaf: unmapped, not guessed
  assert.equal(lookup(sections, 5, 1), null);
  assert.deepEqual(lookup(sections, 5, 2), { key: "deep.js", line: 9, column: 9 });
});

test("malformed mappings are unavailable, even for positions before the damage", () => {
  const good = seg(0, 0, 3, 3);
  const bad = {
    "invalid base64 character": `${good},A!`,
    "truncated continuation digit": `${good},g`,
    "two-field segment": `${good},${vlq(1)}${vlq(0)}`,
    "three-field segment": `${good},${vlq(1)}${vlq(0)}${vlq(0)}`,
    "truncated mid-segment": `${good},${vlq(1)}${vlq(0)}${vlq(0)}g`,
    "overlong VLQ": `${good},gggggggggg`,
    "non-ascii": `${good},\u00e9`,
  };
  for (const [name, text] of Object.entries(bad)) {
    const sections = single(text);
    assert.equal(lookup(sections, 0, 0), null, `${name}: before damage`);
    assert.equal(lookup(sections, 0, 99), null, `${name}: after damage`);
  }
});

test("damage on a later line makes the whole map unavailable", () => {
  const sections = single(`${seg(0, 0, 1, 1)};A!`);
  assert.equal(lookup(sections, 0, 0), null);
  assert.equal(lookup(sections, 1, 0), null);
});

test("invalid inputs are unavailable", () => {
  const sections = single(mappings([[seg(0, 0, 1, 1)]]));
  assert.equal(lookup(sections, -1, 0), null);
  assert.equal(lookup(sections, 0, -1), null);
  assert.equal(lookup(sections, 0.5, 0), null);
  assert.equal(lookup(sections, 0, NaN), null);
  assert.equal(lookup(sections, "0", 0), null);
  assert.equal(lookup(sections, 0, undefined), null);
  assert.equal(lookup(null, 0, 0), null);
  assert.equal(lookup([], 0, 0), null);
  assert.equal(lookup(single(undefined), 0, 0), null);
  const noKeys = createSection({ mappings: mappings([[seg(0, 0, 1, 1)]]) });
  assert.equal(lookup([noKeys], 0, 0), null);
});
