// Packages the built extension (dist/) into one deterministic ZIP and signs
// that exact ZIP as a CRX3 with the existing developer key.
//
//   bun scripts/release/package-release.js [--key path] [--verify crxPath]
//
// The PEM comes from --key or the CRX_PRIVATE_KEY environment variable; a key
// is never generated. CRX_PUBLIC_KEY_SHA256 optionally pins the expected signer.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const crx3stream = require("crx3/lib/crx3stream");
const {
  parseCrx,
  verifyCrx,
  readZipManifest,
  normalizeFingerprint,
  sha256Hex,
} = require("./crx.js");

const root = path.resolve(__dirname, "..", "..");
const ZIP_DATE = new Date(Date.UTC(2020, 0, 1));
const MIN_RSA_BITS = 2048;
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;
const FORBIDDEN_NAME = /(\.(pem|key|crx|p12|pfx|der|env)|^id_(rsa|dsa|ecdsa|ed25519))$/i;
const PRIVATE_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

function loadPrivateKey(pem) {
  if (typeof pem !== "string" || !pem.includes("PRIVATE KEY")) {
    throw new Error("No PEM private key was provided");
  }
  const text = pem.includes("\n") ? pem : pem.replace(/\\n/g, "\n");
  let key;
  try {
    key = crypto.createPrivateKey(text);
  } catch {
    throw new Error("Signing key could not be parsed as a PEM private key");
  }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < MIN_RSA_BITS) {
    throw new Error(`Signing key must be RSA >= ${MIN_RSA_BITS} bits`);
  }
  return key;
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// Lists dist files as sorted [posixName, absolutePath]; rejects anything that is
// not a plain regular extension asset.
function collectFiles(distDir) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${name}`);
      if (entry.name.startsWith(".")) throw new Error(`Refusing to package hidden file: ${name}`);
      if (entry.isDirectory()) {
        walk(full, name);
      } else if (entry.isFile()) {
        if (FORBIDDEN_NAME.test(entry.name))
          throw new Error(`Refusing to package key or secret file: ${name}`);
        found.push([name, full]);
      } else {
        throw new Error(`Refusing to package non-regular file: ${name}`);
      }
    }
  };
  walk(distDir, "");
  found.sort((a, b) => compareBytes(a[0], b[0]));
  return found;
}

function assertNoPrivateMaterial(name, bytes, needles) {
  if (
    PRIVATE_BLOCK.test(bytes.toString("latin1")) ||
    needles.some((needle) => bytes.includes(needle))
  ) {
    throw new Error(`Refusing to package private key material: ${name}`);
  }
}

async function buildZip(distDir, privateKey) {
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  const needles = [der, Buffer.from(der.toString("base64"), "latin1")];
  const zip = new JSZip();
  for (const [name, full] of collectFiles(distDir)) {
    const bytes = fs.readFileSync(full);
    assertNoPrivateMaterial(name, bytes, needles);
    zip.file(name, bytes, { date: ZIP_DATE, unixPermissions: 0o644, createFolders: false });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

// Signs the given ZIP bytes with crx3's stream writer using a private temp key.
async function signZip(zipBytes, privateKey) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-sign-"));
  const keyPath = path.join(tempDir, "key.pem");
  const crxPath = path.join(tempDir, "out.crx");
  try {
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      const stream = crx3stream(crxPath, { keyPath });
      stream.on("error", reject);
      stream.on("close", resolve);
      stream.end(zipBytes);
    });
    return fs.readFileSync(crxPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function packageRelease({ distDir, outputDir, version, privateKeyPem, expectedKeySha256 }) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const privateKey = loadPrivateKey(privateKeyPem);
  const publicDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const keyFingerprint = sha256Hex(publicDer);
  if (expectedKeySha256 != null && expectedKeySha256 !== "") {
    const expected = normalizeFingerprint(expectedKeySha256, "Expected signing key fingerprint");
    if (expected !== keyFingerprint) {
      throw new Error(
        `Signing key does not match the pinned fingerprint (got ${keyFingerprint}, expected ${expected})`
      );
    }
  }

  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath))
    throw new Error(`${manifestPath} not found; run the build first`);
  const distVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
  if (distVersion !== version) {
    throw new Error(
      `dist manifest version ${distVersion} does not match release version ${version}`
    );
  }

  const zipBytes = await buildZip(distDir, privateKey);
  const crxBytes = await signZip(zipBytes, privateKey);

  // Re-verify the artifact exactly as consumers will, against our own key.
  const verified = verifyCrx(crxBytes, keyFingerprint);
  if (!verified.zip.equals(zipBytes))
    throw new Error("Signed CRX payload differs from the packaged ZIP");
  const manifest = await readZipManifest(verified.zip);
  if (manifest.version !== version)
    throw new Error("Packaged manifest version does not match release version");

  const publicPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const release = {
    version,
    signingKeySha256: verified.signingKeySha256,
    signingExtensionId: verified.signingExtensionId,
    zipSha256: sha256Hex(zipBytes),
    crxSha256: sha256Hex(crxBytes),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "devtools-plus-plus.zip"), zipBytes);
  fs.writeFileSync(path.join(outputDir, "devtools-plus-plus.crx"), crxBytes);
  fs.writeFileSync(path.join(outputDir, "signing-public-key.pem"), publicPem);
  fs.writeFileSync(path.join(outputDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

function parseArgs(argv) {
  const options = { key: null, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--key" && flag !== "--verify") throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pin = process.env.CRX_PUBLIC_KEY_SHA256 || undefined;

  if (options.verify) {
    const bytes = fs.readFileSync(options.verify);
    const result = pin ? verifyCrx(bytes, pin) : parseCrx(bytes);
    const manifest = await readZipManifest(result.zip);
    console.log(`manifest version: ${manifest.version}`);
    console.log(`signing key sha256: ${result.signingKeySha256}`);
    console.log(`signing extension id: ${result.signingExtensionId}`);
    console.log(
      pin
        ? "signer matches CRX_PUBLIC_KEY_SHA256"
        : "signer not pinned (CRX_PUBLIC_KEY_SHA256 unset)"
    );
    return;
  }

  const privateKeyPem = options.key
    ? fs.readFileSync(options.key, "utf8")
    : process.env.CRX_PRIVATE_KEY;
  if (!privateKeyPem) throw new Error("Provide a signing key with --key <pem> or CRX_PRIVATE_KEY");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const release = await packageRelease({
    distDir: path.join(root, "dist"),
    outputDir: path.join(root, "out"),
    version,
    privateKeyPem,
    expectedKeySha256: pin,
  });
  console.log(`Packaged ${release.version}`);
  console.log(`signing key sha256: ${release.signingKeySha256}`);
  console.log(`signing extension id: ${release.signingExtensionId}`);
  console.log(`zip sha256: ${release.zipSha256}`);
  console.log(`crx sha256: ${release.crxSha256}`);
}

module.exports = { packageRelease, loadPrivateKey };

if (require.main === module) {
  main().catch((error) => {
    console.error(`package-release: ${error.message}`);
    process.exit(1);
  });
}
