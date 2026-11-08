// CRX3 verification. Parses the container, checks the RSA SHA-256 proof over
// the exact archive bytes, checks the signed crx_id matches the proof key and
// pins the signer to an expected public-key fingerprint. Uses node:crypto for
// all signature work.

"use strict";

const crypto = require("node:crypto");
const Pbf = require("pbf").default;

const MAGIC = Buffer.from("Cr24", "latin1");
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");
const PREAMBLE_SIZE = 12;
const MAX_HEADER_SIZE = 64 * 1024;
const CRX_ID_SIZE = 16;
const MIN_RSA_BITS = 2048;
const WIRE_BYTES = 2;

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeFingerprint(value, label) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${label} must be a SHA-256 hex digest (64 hex characters)`);
  }
  return text;
}

// Chrome extension IDs encode the first 16 bytes of the key hash with a-p.
function extensionIdFromCrxId(crxId) {
  let id = "";
  for (const byte of crxId) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  }
  return id;
}

// Reads one length-delimited field, never trusting the declared length.
function readBytesField(pbf, limit, name) {
  if (pbf.type !== WIRE_BYTES) throw new Error(`Malformed CRX header: ${name} has wrong wire type`);
  const length = pbf.readVarint();
  const start = pbf.pos;
  if (!Number.isSafeInteger(length) || length < 0 || start + length > limit) {
    throw new Error(`Malformed CRX header: ${name} overruns the header`);
  }
  pbf.pos = start + length;
  return Buffer.from(pbf.buf.subarray(start, start + length));
}

function parseFields(bytes, name, onField) {
  const pbf = new Pbf(bytes);
  try {
    pbf.readFields(
      (tag, result, reader) => {
        if (!onField(tag, reader, bytes.length)) {
          throw new Error(`Malformed CRX header: unexpected field ${tag} in ${name}`);
        }
      },
      {},
      bytes.length
    );
  } catch (error) {
    if (error && /^Malformed CRX header/.test(error.message)) throw error;
    throw new Error(`Malformed CRX header: ${name} is not valid protobuf`);
  }
  if (pbf.pos !== bytes.length) throw new Error(`Malformed CRX header: ${name} has trailing bytes`);
}

function parseHeader(header) {
  const proofs = [];
  let signedHeaderData = null;
  parseFields(header, "header", (tag, pbf, limit) => {
    if (tag === 2) {
      proofs.push(readBytesField(pbf, limit, "sha256_with_rsa"));
      return true;
    }
    if (tag === 10000) {
      if (signedHeaderData) throw new Error("Malformed CRX header: duplicate signed_header_data");
      signedHeaderData = readBytesField(pbf, limit, "signed_header_data");
      return true;
    }
    return false;
  });
  if (proofs.length !== 1) throw new Error("CRX must carry exactly one RSA signature proof");
  if (!signedHeaderData) throw new Error("Malformed CRX header: missing signed_header_data");

  let publicKey = null;
  let signature = null;
  parseFields(proofs[0], "proof", (tag, pbf, limit) => {
    if (tag === 1 && !publicKey) {
      publicKey = readBytesField(pbf, limit, "public_key");
      return true;
    }
    if (tag === 2 && !signature) {
      signature = readBytesField(pbf, limit, "signature");
      return true;
    }
    return false;
  });
  if (!publicKey || !signature) throw new Error("Malformed CRX header: incomplete proof");

  let crxId = null;
  parseFields(signedHeaderData, "signed_header_data", (tag, pbf, limit) => {
    if (tag === 1 && !crxId) {
      crxId = readBytesField(pbf, limit, "crx_id");
      return true;
    }
    return false;
  });
  if (!crxId || crxId.length !== CRX_ID_SIZE) throw new Error("Malformed CRX header: bad crx_id");

  return { publicKey, signature, signedHeaderData, crxId };
}

function assertZip(zip) {
  const hasLocalHeader = zip.length >= 22 && zip.readUInt32LE(0) === 0x04034b50;
  const tail = zip.subarray(Math.max(0, zip.length - 65557));
  const hasEnd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
  if (!hasLocalHeader || !hasEnd) throw new Error("CRX payload is not a ZIP archive");
}

// Parses and verifies a CRX3 without pinning the signer. verifyCrx wraps this
// with the required fingerprint pin; use it for anything that is trusted.
function parseCrx(bytes) {
  const crx = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (crx.length < PREAMBLE_SIZE || !crx.subarray(0, 4).equals(MAGIC)) {
    throw new Error("Not a CRX file");
  }
  if (crx.readUInt32LE(4) !== 3) throw new Error("Unsupported CRX version (CRX3 required)");
  const headerSize = crx.readUInt32LE(8);
  if (headerSize === 0 || headerSize > MAX_HEADER_SIZE)
    throw new Error("CRX header size is out of range");
  const zipStart = PREAMBLE_SIZE + headerSize;
  if (zipStart >= crx.length) throw new Error("CRX header overruns the file");

  const { publicKey, signature, signedHeaderData, crxId } = parseHeader(
    crx.subarray(PREAMBLE_SIZE, zipStart)
  );
  const zip = Buffer.from(crx.subarray(zipStart));
  assertZip(zip);

  let keyObject;
  try {
    keyObject = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  } catch {
    throw new Error("CRX public key is not a valid SPKI key");
  }
  if (
    keyObject.asymmetricKeyType !== "rsa" ||
    keyObject.asymmetricKeyDetails.modulusLength < MIN_RSA_BITS
  ) {
    throw new Error(`CRX signing key must be RSA >= ${MIN_RSA_BITS} bits`);
  }
  // Canonical SPKI only, so the fingerprint cannot be altered by re-encoding.
  const canonical = keyObject.export({ type: "spki", format: "der" });
  if (!canonical.equals(publicKey)) throw new Error("CRX public key encoding is not canonical");

  const keyHash = crypto.createHash("sha256").update(publicKey).digest();
  if (!keyHash.subarray(0, CRX_ID_SIZE).equals(crxId)) {
    throw new Error("CRX signed crx_id does not match the signing public key");
  }

  const sizeLe = Buffer.alloc(4);
  sizeLe.writeUInt32LE(signedHeaderData.length, 0);
  const verifier = crypto.createVerify("sha256");
  verifier.update(SIGNATURE_CONTEXT);
  verifier.update(sizeLe);
  verifier.update(signedHeaderData);
  verifier.update(zip);
  if (!verifier.verify(keyObject, signature)) {
    throw new Error("CRX signature does not verify against its archive");
  }

  return {
    zip,
    publicKey,
    signingKeySha256: keyHash.toString("hex"),
    signingExtensionId: extensionIdFromCrxId(crxId),
  };
}

function verifyCrx(bytes, expectedKeySha256) {
  const expected = normalizeFingerprint(expectedKeySha256, "Expected signing key fingerprint");
  const result = parseCrx(bytes);
  if (result.signingKeySha256 !== expected) {
    throw new Error(
      `CRX is signed by an unexpected key (got ${result.signingKeySha256}, expected ${expected})`
    );
  }
  return result;
}

// Reads manifest.json from a ZIP buffer (async: JSZip).
async function readZipManifest(zip) {
  const JSZip = require("jszip");
  const archive = await JSZip.loadAsync(zip);
  const entry = archive.file("manifest.json");
  if (!entry) throw new Error("Archive has no root manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await entry.async("string"));
  } catch {
    throw new Error("Archive manifest.json is not valid JSON");
  }
  if (!manifest || typeof manifest.version !== "string") {
    throw new Error("Archive manifest.json has no version");
  }
  return manifest;
}

module.exports = {
  verifyCrx,
  parseCrx,
  readZipManifest,
  normalizeFingerprint,
  sha256Hex,
};
