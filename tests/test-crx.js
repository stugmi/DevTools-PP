// Security/behavior tests for CRX packaging and verification (crx.js,
// package-release.js). Run with `bun test tests/test-crx.js`.
// Only throwaway RSA keys generated here are ever used.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const Pbf = require("pbf").default;
const crxpb = require("crx3/lib/crx3.pb.js");
const { verifyCrx, parseCrx } = require("../scripts/release/crx.js");
const { packageRelease } = require("../scripts/release/package-release.js");

const newKey = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pemOf = (key) => key.export({ type: "pkcs8", format: "pem" });
const spkiOf = (key) => crypto.createPublicKey(key).export({ type: "spki", format: "der" });
const fingerprintOf = (key) => crypto.createHash("sha256").update(spkiOf(key)).digest("hex");

const keyA = newKey();
const keyB = newKey();
const tempDirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crx-test-"));
  tempDirs.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDist(version = "1.2.3", extra = {}) {
  const dist = path.join(tempDir(), "dist");
  fs.mkdirSync(path.join(dist, "panel"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "manifest.json"),
    JSON.stringify({ manifest_version: 3, version })
  );
  fs.writeFileSync(path.join(dist, "panel", "panel.js"), "console.log('panel');\n");
  fs.writeFileSync(path.join(dist, "a.txt"), "first\n");
  for (const [name, content] of Object.entries(extra))
    fs.writeFileSync(path.join(dist, name), content);
  return dist;
}

async function pack({
  key = keyA,
  version = "1.2.3",
  dist = makeDist(version),
  expectedKeySha256,
} = {}) {
  const outputDir = path.join(tempDir(), "out");
  const release = await packageRelease({
    distDir: dist,
    outputDir,
    version,
    privateKeyPem: pemOf(key),
    expectedKeySha256,
  });
  return { release, outputDir, dist };
}

// Builds a CRX the way a signer would, but lets tests corrupt individual parts.
function buildCrx({ signKey = keyA, proofKey = signKey, crxId, zip, headerSize, mutateHeader }) {
  const proofDer = spkiOf(proofKey);
  const id = crxId || crypto.createHash("sha256").update(proofDer).digest().subarray(0, 16);
  const signedPb = new Pbf();
  crxpb.writeSignedData({ crx_id: id }, signedPb);
  const signedData = Buffer.from(signedPb.finish());
  const sizeLe = Buffer.alloc(4);
  sizeLe.writeUInt32LE(signedData.length);
  const signer = crypto.createSign("sha256");
  signer.update(Buffer.from("CRX3 SignedData\x00", "latin1"));
  signer.update(sizeLe);
  signer.update(signedData);
  signer.update(zip);
  const headerPb = new Pbf();
  crxpb.writeCrxFileHeader(
    {
      sha256_with_rsa: [{ public_key: proofDer, signature: signer.sign(signKey) }],
      signed_header_data: signedData,
    },
    headerPb
  );
  let header = Buffer.from(headerPb.finish());
  if (mutateHeader) header = mutateHeader(header);
  const preamble = Buffer.alloc(12);
  preamble.write("Cr24", 0, "latin1");
  preamble.writeUInt32LE(3, 4);
  preamble.writeUInt32LE(headerSize ?? header.length, 8);
  return Buffer.concat([preamble, header, zip]);
}

const smallZip = async (version = "1.2.3") => {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ version }));
  return zip.generateAsync({ type: "nodebuffer" });
};

test("packaged CRX verifies, signs the exact ZIP and exposes the pinned key", async () => {
  const { release, outputDir } = await pack();
  const crx = fs.readFileSync(path.join(outputDir, "devtools-plus-plus.crx"));
  const zip = fs.readFileSync(path.join(outputDir, "devtools-plus-plus.zip"));
  const result = verifyCrx(crx, fingerprintOf(keyA));

  assert.ok(result.zip.equals(zip));
  assert.equal(result.signingKeySha256, fingerprintOf(keyA));
  assert.match(result.signingExtensionId, /^[a-p]{32}$/);
  assert.ok(result.publicKey.equals(spkiOf(keyA)));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outputDir, "release.json"), "utf8")),
    release
  );
  assert.equal(release.signingExtensionId, result.signingExtensionId);
  assert.equal(release.zipSha256, crypto.createHash("sha256").update(zip).digest("hex"));
  assert.equal(release.crxSha256, crypto.createHash("sha256").update(crx).digest("hex"));

  const published = fs.readFileSync(path.join(outputDir, "signing-public-key.pem"), "utf8");
  assert.ok(
    crypto.createPublicKey(published).export({ type: "spki", format: "der" }).equals(spkiOf(keyA))
  );
  assert.doesNotMatch(published, /PRIVATE/);

  const archive = await JSZip.loadAsync(zip);
  const names = Object.keys(archive.files);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(names, ["a.txt", "manifest.json", "panel/panel.js"]);
});

test("packaging is deterministic and carries no private material", async () => {
  const dist = makeDist();
  const first = await pack({ dist });
  const second = await pack({ dist });
  const read = (r, f) => fs.readFileSync(path.join(r.outputDir, f));
  assert.ok(read(first, "devtools-plus-plus.zip").equals(read(second, "devtools-plus-plus.zip")));
  assert.ok(read(first, "devtools-plus-plus.crx").equals(read(second, "devtools-plus-plus.crx")));

  const der = keyA.export({ type: "pkcs8", format: "der" });
  for (const file of fs.readdirSync(first.outputDir)) {
    const bytes = read(first, file);
    assert.ok(!bytes.includes(der), `${file} contains private key DER`);
    assert.doesNotMatch(bytes.toString("latin1"), /PRIVATE KEY/);
  }
});

test("a flipped archive byte or signature byte fails verification", async () => {
  const { outputDir } = await pack();
  const crx = fs.readFileSync(path.join(outputDir, "devtools-plus-plus.crx"));
  const pin = fingerprintOf(keyA);

  const archiveTampered = Buffer.from(crx);
  archiveTampered[crx.length - 30] ^= 0x01;
  assert.throws(() => verifyCrx(archiveTampered, pin));

  const headerSize = crx.readUInt32LE(8);
  const signatureTampered = Buffer.from(crx);
  signatureTampered[12 + headerSize - 5] ^= 0x01; // inside signed_header_data/signature region
  assert.throws(() => verifyCrx(signatureTampered, pin));

  assert.throws(() => verifyCrx(crx.subarray(0, crx.length - 40), pin));
  assert.doesNotThrow(() => verifyCrx(crx, pin));
});

test("a different signing key is rejected even though the signature is valid", async () => {
  const zip = await smallZip();
  const crx = buildCrx({ signKey: keyB, zip });
  assert.equal(parseCrx(crx).signingKeySha256, fingerprintOf(keyB));
  assert.throws(() => verifyCrx(crx, fingerprintOf(keyA)), /unexpected key/);
  assert.doesNotThrow(() => verifyCrx(crx, fingerprintOf(keyB)));
  assert.throws(() => verifyCrx(crx, "not-a-fingerprint"), /SHA-256/);
});

test("proof key that did not produce the signature is rejected", async () => {
  const zip = await smallZip();
  // Header advertises key A but the signature was made by key B.
  const crx = buildCrx({ signKey: keyB, proofKey: keyA, zip });
  assert.throws(() => verifyCrx(crx, fingerprintOf(keyA)), /signature/);
});

test("signed crx_id must be derived from the proof public key", async () => {
  const zip = await smallZip();
  const foreignId = crypto.createHash("sha256").update(spkiOf(keyB)).digest().subarray(0, 16);
  const crx = buildCrx({ signKey: keyA, crxId: foreignId, zip });
  assert.throws(() => verifyCrx(crx, fingerprintOf(keyA)), /crx_id/);
});

test("malformed containers are rejected", async () => {
  const zip = await smallZip();
  const pin = fingerprintOf(keyA);
  const good = buildCrx({ zip });
  assert.doesNotThrow(() => verifyCrx(good, pin));

  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;
  assert.throws(() => verifyCrx(badMagic, pin), /Not a CRX/);

  const crx2 = Buffer.from(good);
  crx2.writeUInt32LE(2, 4);
  assert.throws(() => verifyCrx(crx2, pin), /version/);

  assert.throws(() => verifyCrx(buildCrx({ zip, headerSize: 10 * 1024 * 1024 }), pin), /size/);
  assert.throws(() => verifyCrx(buildCrx({ zip, headerSize: good.length }), pin));
  assert.throws(() => verifyCrx(buildCrx({ zip, headerSize: 0 }), pin));
  assert.throws(() => verifyCrx(Buffer.alloc(5), pin));

  // Garbage protobuf and trailing junk inside the header.
  assert.throws(() =>
    verifyCrx(
      buildCrx({ zip, mutateHeader: (h) => Buffer.concat([h, Buffer.from([0xff, 0xff])]) }),
      pin
    )
  );
  assert.throws(() =>
    verifyCrx(buildCrx({ zip, mutateHeader: (h) => h.subarray(0, h.length - 7) }), pin)
  );
  // Unknown extra field (tag 5, bytes) is not accepted.
  assert.throws(() =>
    verifyCrx(
      buildCrx({ zip, mutateHeader: (h) => Buffer.concat([h, Buffer.from([0x2a, 0x01, 0x00])]) }),
      pin
    )
  );

  // Payload must be a ZIP.
  assert.throws(
    () => verifyCrx(buildCrx({ zip: Buffer.from("not a zip archive at all, sorry!") }), pin),
    /ZIP/
  );
});

test("package refuses a dist whose manifest version differs from the release", async () => {
  const dist = makeDist("1.2.3");
  const outputDir = path.join(tempDir(), "out");
  await assert.rejects(
    packageRelease({ distDir: dist, outputDir, version: "1.2.4", privateKeyPem: pemOf(keyA) }),
    /does not match/
  );
  assert.ok(!fs.existsSync(outputDir));
});

test("package refuses a signing key that does not match the pin and writes nothing", async () => {
  const outputDir = path.join(tempDir(), "out");
  await assert.rejects(
    packageRelease({
      distDir: makeDist(),
      outputDir,
      version: "1.2.3",
      privateKeyPem: pemOf(keyB),
      expectedKeySha256: fingerprintOf(keyA),
    }),
    /pinned fingerprint/
  );
  assert.ok(!fs.existsSync(outputDir));
  await assert.rejects(
    packageRelease({
      distDir: makeDist(),
      outputDir,
      version: "1.2.3",
      privateKeyPem: "not a key",
    }),
    /private key/
  );
});

test("package refuses keys, secrets and symlinks inside dist", async () => {
  const cases = {
    "key file": { "signing.pem": "x" },
    "env file": { ".env": "TOKEN=1" },
    "inline private key": { "notes.txt": pemOf(keyA) },
    "raw key bytes": { "blob.bin": keyA.export({ type: "pkcs8", format: "der" }) },
  };
  for (const [label, extra] of Object.entries(cases)) {
    const outputDir = path.join(tempDir(), "out");
    await assert.rejects(
      packageRelease({
        distDir: makeDist("1.2.3", extra),
        outputDir,
        version: "1.2.3",
        privateKeyPem: pemOf(keyA),
      }),
      /Refusing/,
      label
    );
    assert.ok(!fs.existsSync(outputDir), label);
  }

  const dist = makeDist();
  try {
    fs.symlinkSync(path.join(dist, "a.txt"), path.join(dist, "link.txt"));
  } catch {
    return; // symlinks unavailable on this host
  }
  await assert.rejects(
    packageRelease({
      distDir: dist,
      outputDir: path.join(tempDir(), "out"),
      version: "1.2.3",
      privateKeyPem: pemOf(keyA),
    }),
    /symlink/
  );
});
