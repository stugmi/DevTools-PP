"use strict";

// Runs Betterleaks (https://github.com/betterleaks/betterleaks) at one pinned release.
//
//   bun scripts/secrets/betterleaks.js install   download and checksum-verify the pinned build into .dev/bin
//   bun scripts/secrets/betterleaks.js staged    scan staged changes (used by .githooks/pre-commit)
//   bun scripts/secrets/betterleaks.js history   scan the whole git history (used by CI and `bun run secrets`)
//
// BETTERLEAKS_BIN may point at your own binary, but it must report the pinned version. Findings are
// always redacted so a CI log never prints the secret it found. To upgrade, change VERSION and the
// SHA-256 values below from the release's checksums.txt, then re-check the flags: v2 releases replace
// `git --staged` with piping `git diff --cached` into `betterleaks stdin --git-diff`.

const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "1.10.0";
const ASSETS = {
  "win32-x64": [
    "windows_x64.zip",
    "bafd52abcb440c2a06ea36d5e1fff217315db0aac517e60d74e64b2bb9f18468",
  ],
  "win32-arm64": [
    "windows_arm64.zip",
    "0799fdc4588a934fd5d727920117a5e0d5d24d2cdead55445e84c5619d201d9c",
  ],
  "linux-x64": [
    "linux_x64.tar.gz",
    "9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe",
  ],
  "linux-arm64": [
    "linux_arm64.tar.gz",
    "3d7585cbe4f947aef6e31662f65beb5b43b104381a691b6b81b157ebfbb0c02d",
  ],
  "darwin-x64": [
    "darwin_x64.tar.gz",
    "71b3f30602856e622008c248b1b47b2ba15b227f4a033e8bfdfa05a21ec7d531",
  ],
  "darwin-arm64": [
    "darwin_arm64.tar.gz",
    "91eaea97709d3308c7712574a56260539c65fbd0672711537aa68d566ea630b3",
  ],
};

const root = path.resolve(__dirname, "..", "..");
const exeName = process.platform === "win32" ? "betterleaks.exe" : "betterleaks";
const installPath = path.join(root, ".dev", "bin", exeName);
const configPath = path.join(root, ".betterleaks.toml");

function pinnedAsset() {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `No pinned Betterleaks build for ${key}; set BETTERLEAKS_BIN to your own ${VERSION} binary`
    );
  }
  return asset;
}

function versionOf(bin) {
  if (!fs.existsSync(bin)) return null;
  const result = cp.spawnSync(bin, ["version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveBin() {
  const bin = process.env.BETTERLEAKS_BIN || installPath;
  const found = versionOf(bin);
  if (found !== VERSION) {
    const detail = found ? `found ${found}` : "not found";
    throw new Error(
      `Betterleaks ${VERSION} required at ${bin} (${detail}); run: bun run secrets:install`
    );
  }
  return bin;
}

async function extract(name, bytes) {
  if (name.endsWith(".zip")) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file(exeName);
    if (!entry) throw new Error(`${exeName} is missing from ${name}`);
    return Buffer.from(await entry.async("uint8array"));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterleaks-"));
  try {
    const archive = path.join(dir, name);
    fs.writeFileSync(archive, bytes);
    const untar = cp.spawnSync("tar", ["-xzf", archive, "-C", dir, exeName], { encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    return fs.readFileSync(path.join(dir, exeName));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function install() {
  const bin = process.env.BETTERLEAKS_BIN || installPath;
  if (versionOf(bin) === VERSION) {
    console.log(`Betterleaks ${VERSION} already installed at ${bin}`);
    return;
  }
  const [suffix, sha256] = pinnedAsset();
  const name = `betterleaks_${VERSION}_${suffix}`;
  const url = `https://github.com/betterleaks/betterleaks/releases/download/v${VERSION}/${name}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`Checksum mismatch for ${name}: expected ${sha256}, got ${actual}`);
  }
  const binary = await extract(name, bytes);
  fs.mkdirSync(path.dirname(installPath), { recursive: true });
  fs.writeFileSync(installPath, binary, { mode: 0o755 });
  const found = versionOf(installPath);
  if (found !== VERSION) throw new Error(`Installed binary reports ${found}, expected ${VERSION}`);
  console.log(`Installed Betterleaks ${VERSION} at ${installPath}`);
}

// Never auto-load a config from the scanned target; pass ours explicitly when it exists.
// --validation=false keeps candidate secrets from being sent to provider APIs, and the default
// `git` scan already walks every ref (branches, remotes, tags), not just HEAD.
function scan(args) {
  const bin = resolveBin();
  const config = fs.existsSync(configPath) ? ["--config", configPath] : [];
  const common = [
    "--redact",
    "--verbose",
    "--no-banner",
    "--no-color",
    "--validation=false",
    ...config,
  ];
  const result = cp.spawnSync(bin, [...args, ...common], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const commands = {
  install: async () => {
    await install();
    return 0;
  },
  staged: async () => scan(["git", "--pre-commit", "--staged", root]),
  history: async () => scan(["git", root]),
};

const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: bun scripts/secrets/betterleaks.js <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
command()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`betterleaks: ${error.message}`);
    process.exit(2);
  });
