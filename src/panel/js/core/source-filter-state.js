// Source filter and explorer grouping state: which captured files are shown (include/exclude
// rules from lib/source-filter.js) and how the explorer groups them. Applies to the Authored and
// Deployed sections and their exports; the Network list has its own filters.
// Loaded after state.js, before everything that builds or renders the tree.
"use strict";

const SOURCE_GROUP_OPTIONS = Object.freeze([
  { value: "auto", label: "Automatic" },
  { value: "domain", label: "Domain" },
  { value: "type", label: "File type" },
  { value: "none", label: "No grouping" },
]);

const SOURCE_FILTER_SYNTAX =
  "Rules: *.js, src/**, github.com, react, .min.js, ext:css, type:font, domain:cdn.example.com, path:components, file:Ago, /regex/i.";

// One line for the rules that were ignored because they do not parse.
function sourceFilterRuleStatus(errors) {
  if (!errors.length) return "";
  return "Ignored: " + errors.map(({ rule, message }) => `${rule} (${message})`).join("; ");
}
function storePref(key, value) {
  prefs[key] = value;
  savePref(key, value);
}

// -- Filtering --

// What the rules see for an entry. Cached per entry: a filter edit re-tests thousands of files.
const filterTargets = new WeakMap();

function sourceFilterTarget(path, entry) {
  const cached = filterTargets.get(entry);
  if (cached?.path === path) return cached;
  const target = SourceFilter.makeTarget(
    path,
    [entry?.scriptURL, entry?.sourceURL],
    entryHost(entry)
  );
  filterTargets.set(entry, target);
  return target;
}

function sourceFilterMatches(section, path, entry) {
  if (section === "requests" || !state.sourceFilter.active) return true;
  return state.sourceFilter.matches(sourceFilterTarget(path, entry));
}

function filteredTreeFor(section) {
  const tree = treeFor(section);
  if (section === "requests" || !state.sourceFilter.active) return tree;
  const out = Object.create(null);
  for (const path in tree) {
    if (sourceFilterMatches(section, path, tree[path])) out[path] = tree[path];
  }
  return out;
}

// { shown, total } over the files the filter applies to.
function sourceFilterCounts() {
  let shown = 0;
  let total = 0;
  for (const section of ["mapped", "raw"]) {
    const tree = treeFor(section);
    for (const path in tree) {
      total++;
      if (sourceFilterMatches(section, path, tree[path])) shown++;
    }
  }
  return { shown, total };
}

// Status bar chip: visible while the filter has rules (active or paused) or a rule is invalid.
function updateSourceFilterUI() {
  const filter = state.sourceFilter;
  const visible = filter.ruleCount > 0 || filter.hasErrors;
  el.statusFilter.hidden = !visible;
  el.statusFilter.classList.toggle("paused", visible && !filter.enabled);
  el.statusFilter.classList.toggle("error", filter.enabled && filter.hasErrors && !filter.active);
  if (visible) {
    if (!filter.enabled) {
      el.statusFilter.textContent = "Source filter paused";
    } else if (filter.active) {
      const { shown, total } = sourceFilterCounts();
      el.statusFilter.textContent = `Source filter: ${shown} of ${total} files`;
    } else {
      el.statusFilter.textContent = "Source filter: invalid rule";
    }
  }
  window.SourceFilterPanel?.refresh();
}

// Applies any of { enabled, include, exclude }: stores them, recompiles and redraws the explorer.
function setSourceFilter(change) {
  if (change.enabled !== undefined) storePref("sourceFilterEnabled", Boolean(change.enabled));
  if (change.include !== undefined) storePref("sourceFilterInclude", String(change.include));
  if (change.exclude !== undefined) storePref("sourceFilterExclude", String(change.exclude));
  state.sourceFilter = SourceFilter.createFilter({
    enabled: prefs.sourceFilterEnabled,
    include: prefs.sourceFilterInclude,
    exclude: prefs.sourceFilterExclude,
  });
  rebuild();
}

// -- Grouping --

// The virtual first-level folder files are shown under: "domain", "type" or "none". Authored files
// group by domain unless told otherwise. Deployed paths already start with their host folder, so
// domain grouping only adds a level there when folders are off.
function groupModeFor(section) {
  if (section === "requests") return "none";
  const choice = prefs.sourceGroupBy;
  if (choice === "auto") return section === "mapped" ? "domain" : "none";
  if (choice === "domain" && section === "raw" && prefs.sourceNestFolders) return "none";
  return choice;
}

function nestFoldersFor(section) {
  return section === "requests" || prefs.sourceNestFolders;
}

// The group key of a file ("" when ungrouped): the host for domain groups, a type id for types.
function groupOf(section, path, entry) {
  const mode = groupModeFor(section);
  if (mode === "domain") return domainOf(entry);
  if (mode === "type") return SourceFilter.typeOf(path);
  return "";
}

function groupLabelFor(section, group) {
  return groupModeFor(section) === "type" ? SourceFilter.typeLabel(group) : group;
}

// Folders a file sits under in the explorer, outermost first: its group, then its directories.
function treeAncestors(section, filePath, entry) {
  const group = groupOf(section, filePath, entry);
  const out = [];
  if (group) out.push({ path: "", group });
  if (nestFoldersFor(section)) {
    let dirPath = "";
    for (const part of filePath.split("/").filter(Boolean).slice(0, -1)) {
      dirPath += (dirPath ? "/" : "") + part;
      out.push({ path: dirPath, group });
    }
  }
  return out;
}

function setSourceGrouping(change) {
  if (change.groupBy !== undefined) storePref("sourceGroupBy", change.groupBy);
  if (change.nestFolders !== undefined) storePref("sourceNestFolders", Boolean(change.nestFolders));
  rebuild();
}
