// Prints one version's release notes from CHANGELOG.md: the body of its `## <version>` section.
// Usage: bun scripts/release/changelog-notes.js [version]   (defaults to the package.json version)
// Exits with an error when the section is missing or empty, so a release never ships blank notes.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const version = process.argv[2] || require(path.join(root, "package.json")).version;
const lines = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);

const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
if (end === -1) end = lines.length;

const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`CHANGELOG.md section "## ${version}" is empty`);
  process.exit(1);
}
process.stdout.write(notes + "\n");
