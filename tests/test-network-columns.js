// Behavioral tests for the request table column layout (src/panel/js/lib/network-columns.js).
// Run with `bun test tests/test-network-columns.js`. The lib is a classic script defining a
// top-level `NetworkColumns` const, so it is evaluated in a vm context (no DOM needed).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "panel", "js", "lib", "network-columns.js"),
  "utf8"
);
const NetworkColumns = vm.runInContext(`${source}\nNetworkColumns`, vm.createContext({}));
const { defaultLayout, normalize, toggle, setWidth, resetWidth, gridTemplate, minWidth, visible } =
  NetworkColumns;

// The lib runs in its own vm realm, so its arrays and objects have foreign prototypes; compare
// them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (layout) => visible(layout).map((column) => column.id);

test("a stored layout that is missing, corrupt or the wrong shape falls back to the default", () => {
  for (const raw of [null, undefined, "", "not json", "[1,2]", "null", "7", 7, []]) {
    assert.deepEqual(plain(normalize(raw)), plain(defaultLayout()), String(raw));
  }
});

test("normalize keeps only hideable known columns, once each, and clamps widths", () => {
  const layout = normalize(
    JSON.stringify({
      hidden: ["domain", "name", "bogus", "domain", 5, "time"],
      widths: {
        status: 9999,
        size: 1,
        domain: 210.4,
        name: 300,
        bogus: 80,
        time: "wide",
        type: null,
      },
    })
  );
  assert.deepEqual(plain(layout.hidden), ["domain", "time"]);
  // status is capped at 800, size raised to its 44px minimum, domain rounded, bad values dropped.
  assert.deepEqual(plain(layout.widths), { status: 800, size: 44, domain: 210, name: 300 });
});

test("Name can never be hidden, so the table always shows at least that column", () => {
  const hidden = normalize({
    hidden: ["method", "status", "type", "domain", "size", "time", "timestamp", "name"],
  });
  assert.deepEqual(plain(ids(hidden)), ["name"]);
  assert.deepEqual(plain(ids(toggle(defaultLayout(), "name"))), plain(ids(defaultLayout())));
});

test("toggle hides a column and shows it again without touching its width", () => {
  let layout = setWidth(defaultLayout(), "domain", 220);
  layout = toggle(layout, "domain");
  assert.equal(ids(layout).includes("domain"), false);
  assert.equal(layout.widths.domain, 220);
  layout = toggle(layout, "domain");
  assert.equal(ids(layout).includes("domain"), true);
  assert.deepEqual(plain(ids(layout)), [
    "name",
    "method",
    "status",
    "type",
    "domain",
    "size",
    "time",
    "timestamp",
  ]);
});

test("setWidth respects each column's minimum and the shared maximum; resetWidth restores it", () => {
  assert.equal(setWidth(defaultLayout(), "status", 1).widths.status, 52);
  assert.equal(setWidth(defaultLayout(), "name", 10).widths.name, 120);
  assert.equal(setWidth(defaultLayout(), "domain", 5000).widths.domain, 800);
  assert.equal(setWidth(defaultLayout(), "domain", NaN).widths.domain, undefined);
  assert.equal(setWidth(defaultLayout(), "bogus", 100).widths.bogus, undefined);
  const resized = setWidth(defaultLayout(), "domain", 300);
  assert.equal(resetWidth(resized, "domain").widths.domain, undefined);
});

test("the default layout shows Method after a fluid Name", () => {
  assert.equal(
    gridTemplate(defaultLayout()),
    "minmax(120px, 1fr) 64px 64px 64px 160px 68px 76px 92px"
  );
});

test("hidden columns leave the tracks, and cells line up with what remains", () => {
  const layout = toggle(toggle(defaultLayout(), "domain"), "timestamp");
  assert.equal(gridTemplate(layout), "minmax(120px, 1fr) 64px 64px 64px 68px 76px");
});

test("a fixed-width Name gets an empty trailing track so the other widths hold", () => {
  const layout = setWidth(defaultLayout(), "name", 400);
  assert.equal(gridTemplate(layout), "400px 64px 64px 64px 160px 68px 76px 92px minmax(0, 1fr)");
});

test("minWidth is the narrowest the table can be before it scrolls", () => {
  // 120 + 64 + 64 + 64 + 160 + 68 + 76 + 92 = 708, seven 10px gaps, 20px of padding.
  assert.equal(minWidth(defaultLayout()), 708 + 70 + 20);
  // Fixed Name adds the empty track: one more gap, no extra width.
  assert.equal(minWidth(setWidth(defaultLayout(), "name", 400)), 988 + 80 + 20);
  assert.equal(minWidth(toggle(defaultLayout(), "domain")) < minWidth(defaultLayout()), true);
});

test("serialize and normalize round-trip a layout", () => {
  let layout = toggle(defaultLayout(), "size");
  layout = setWidth(layout, "type", 90);
  assert.deepEqual(normalize(NetworkColumns.serialize(layout)), layout);
});

// -- Order --
const { move, orderIndex } = NetworkColumns;
const DEFAULT_IDS = ["name", "method", "status", "type", "domain", "size", "time", "timestamp"];

test("an untouched layout has the default order and stores no order", () => {
  assert.deepEqual(plain(ids(defaultLayout())), DEFAULT_IDS);
  assert.deepEqual(plain(defaultLayout().order), []);
  assert.deepEqual(plain(JSON.parse(NetworkColumns.serialize(defaultLayout())).order), []);
});

test("move puts a column before or after another and shows it in that place", () => {
  const before = move(defaultLayout(), "time", "status", false);
  assert.deepEqual(plain(ids(before)), [
    "name",
    "method",
    "time",
    "status",
    "type",
    "domain",
    "size",
    "timestamp",
  ]);
  const after = move(defaultLayout(), "name", "timestamp", true);
  assert.deepEqual(plain(ids(after)), [...DEFAULT_IDS.slice(1), "name"]);
});

test("moving a column onto itself, or back to where it was, changes nothing", () => {
  const same = move(defaultLayout(), "status", "status");
  assert.deepEqual(plain(same), plain(defaultLayout()));
  const there = move(defaultLayout(), "method", "status", false);
  assert.deepEqual(plain(there.order), []);
  const moved = move(defaultLayout(), "size", "type", false);
  const back = move(moved, "size", "time", false);
  assert.deepEqual(plain(back.order), []);
  assert.deepEqual(plain(ids(move(defaultLayout(), "bogus", "status"))), DEFAULT_IDS);
  assert.deepEqual(plain(ids(move(defaultLayout(), "status", "bogus"))), DEFAULT_IDS);
});

test("the grid tracks follow the column order, so each width stays with its column", () => {
  const layout = move(defaultLayout(), "domain", "status", false);
  assert.equal(gridTemplate(layout), "minmax(120px, 1fr) 64px 160px 64px 64px 68px 76px 92px");
  assert.equal(minWidth(layout), minWidth(defaultLayout()));
  const resized = setWidth(layout, "domain", 220);
  assert.equal(gridTemplate(resized), "minmax(120px, 1fr) 64px 220px 64px 64px 68px 76px 92px");
});

test("hiding, showing and resizing columns keep their order", () => {
  let layout = move(defaultLayout(), "timestamp", "method", false);
  layout = toggle(layout, "status");
  assert.deepEqual(plain(ids(layout)), [
    "name",
    "timestamp",
    "method",
    "type",
    "domain",
    "size",
    "time",
  ]);
  layout = setWidth(layout, "type", 90);
  layout = toggle(layout, "status");
  assert.deepEqual(plain(ids(layout)), [
    "name",
    "timestamp",
    "method",
    "status",
    "type",
    "domain",
    "size",
    "time",
  ]);
});

test("a hidden column keeps its place for when it is shown again", () => {
  let layout = toggle(defaultLayout(), "domain");
  layout = move(layout, "time", "size", false);
  layout = toggle(layout, "domain");
  assert.deepEqual(plain(ids(layout)), [
    "name",
    "method",
    "status",
    "type",
    "domain",
    "time",
    "size",
    "timestamp",
  ]);
});

test("a stored order is repaired: unknown and repeated ids dropped, missing columns appended", () => {
  const layout = normalize({ order: ["time", "bogus", "time", 4, "name", "size"] });
  assert.deepEqual(plain(ids(layout)), [
    "time",
    "name",
    "size",
    "method",
    "status",
    "type",
    "domain",
    "timestamp",
  ]);
  assert.deepEqual(plain(normalize({ order: DEFAULT_IDS }).order), []);
  for (const bad of ["x", 5, null, {}]) {
    assert.deepEqual(plain(normalize({ order: bad }).order), [], String(bad));
  }
});

test("a layout stored before ordering existed loads in the default order", () => {
  const layout = normalize(JSON.stringify({ hidden: ["domain"], widths: { status: 90 } }));
  assert.deepEqual(
    plain(ids(layout)),
    DEFAULT_IDS.filter((id) => id !== "domain")
  );
  assert.equal(layout.widths.status, 90);
});

test("orderIndex numbers columns by their place in the order", () => {
  const layout = move(defaultLayout(), "timestamp", "name", false);
  assert.equal(orderIndex(layout, "timestamp"), 0);
  assert.equal(orderIndex(layout, "name"), 1);
  assert.equal(orderIndex(layout, "time"), 7);
});

test("order survives serialize and normalize", () => {
  let layout = move(defaultLayout(), "size", "name", false);
  layout = toggle(layout, "type");
  assert.deepEqual(plain(normalize(NetworkColumns.serialize(layout))), plain(layout));
});
