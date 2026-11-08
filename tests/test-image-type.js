// Behavioral tests for image detection: ImageType (src/panel/js/lib/image-type.js) and the
// response helpers in src/panel/js/network/request-body.js that use it. Run with
// `bun test tests/test-image-type.js`. Both are classic scripts, evaluated in one vm context.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const panelFile = (...parts) =>
  fs.readFileSync(path.join(__dirname, "..", "src", "panel", "js", ...parts), "utf8");

const context = vm.createContext({
  atob,
  baseMime: (mime) => (mime || "").split(";")[0].trim().toLowerCase(),
  parseJsonExact: JSON.parse,
  stringifyJsonExact: JSON.stringify,
  langFromContentType: () => null,
  formatJsonText: (text) => text,
  tryPretty: () => ({ ok: false }),
});
vm.runInContext(panelFile("lib", "json-payload.js"), context);
const ImageType = vm.runInContext(`${panelFile("lib", "image-type.js")}\nImageType`, context);
const { responseImageMime, bodyShowsImage } = vm.runInContext(
  `${panelFile("network", "request-body.js")}\n({ responseImageMime, bodyShowsImage })`,
  context
);

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const pad = (bytes, length = 32) => Uint8Array.from([...bytes, ...new Array(length).fill(0)]);
const le32 = (value) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

const SAMPLES = {
  "image/png": pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": pad([0xff, 0xd8, 0xff, 0xe0]),
  "image/gif": pad(ascii("GIF89a")),
  "image/webp": pad([...ascii("RIFF"), 0xf2, 0x70, 0, 0, ...ascii("WEBPVP8 ")]),
  "image/avif": pad([0, 0, 0, 0x1c, ...ascii("ftypavif")]),
  "image/bmp": pad([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, ...le32(40)]),
  "image/x-icon": pad([0, 0, 1, 0, 2, 0]),
};

test("every supported image type is recognized from its leading bytes", () => {
  for (const [mime, bytes] of Object.entries(SAMPLES)) {
    assert.equal(ImageType.sniff(bytes), mime, mime);
  }
});

test("the same bytes are recognized from base64 text, with or without line breaks", () => {
  for (const [mime, bytes] of Object.entries(SAMPLES)) {
    const text = base64(bytes);
    assert.equal(ImageType.sniffBase64(text), mime, mime);
    assert.equal(ImageType.sniffBase64(text.replace(/(.{20})/g, "$1\n")), mime, `${mime} wrapped`);
  }
});

test("text, noise and look-alike containers are not images", () => {
  const notImages = {
    json: ascii('{"a":1,"b":[1,2,3]}'),
    html: ascii("<!doctype html><html></html>"),
    "bare BM text": ascii("BM is a prefix in plain prose, nothing more."),
    "RIFF wave": [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVEfmt ")],
    "mp4 brand": [0, 0, 0, 0x18, ...ascii("ftypmp42"), 0, 0, 0, 0],
    "ico with no images": [0, 0, 1, 0, 0, 0, 0, 0],
    zip: ascii("PK\u0003\u0004 archive"),
    "too short": [0x89, 0x50],
    empty: [],
  };
  for (const [name, bytes] of Object.entries(notImages)) {
    assert.equal(ImageType.sniff(pad(bytes)), null, name);
  }
  assert.equal(ImageType.sniff(null), null);
});

test("base64 that is invalid, short or not text is not an image", () => {
  assert.equal(ImageType.sniffBase64("!!!!not base64!!!!"), null);
  assert.equal(ImageType.sniffBase64("iVBO"), null);
  assert.equal(ImageType.sniffBase64(""), null);
  assert.equal(ImageType.sniffBase64(null), null);
  assert.equal(ImageType.sniffBase64({ encoding: "base64" }), null);
});

// A response as the capture hands it to request-body.js.
const response = ({ mime, bytes, text, encoding }) => ({
  _record: { response: { bodyMimeType: mime, bodyEncoding: encoding ?? null } },
  _rawResponseBody: bytes ? base64(bytes) : text,
});

test("an image behind a generic or missing Content-Type is still an image", () => {
  for (const mime of ["application/octet-stream", "binary/octet-stream", "", undefined]) {
    const entry = response({ mime, bytes: SAMPLES["image/webp"], encoding: "base64" });
    assert.equal(responseImageMime(entry), "image/webp", String(mime));
  }
});

test("the bytes win over a wrong declared image type", () => {
  const entry = response({
    mime: "image/png",
    bytes: SAMPLES["image/webp"],
    encoding: "base64",
  });
  assert.equal(responseImageMime(entry), "image/webp");
});

test("a declared raster type is kept when the bytes are not recognized; SVG is not raster", () => {
  const unknown = response({ mime: "image/heic", bytes: pad([1, 2, 3, 4]), encoding: "base64" });
  assert.equal(responseImageMime(unknown), "image/heic");
  const svg = response({ mime: "image/svg+xml", text: "<svg></svg>" });
  assert.equal(responseImageMime(svg), null);
});

test("binary that is not an image, and text bodies, are not images", () => {
  const zip = response({
    mime: "application/zip",
    bytes: pad(ascii("PK\u0003\u0004")),
    encoding: "base64",
  });
  assert.equal(responseImageMime(zip), null);
  const json = response({ mime: "application/json", text: '{"a":1}' });
  assert.equal(responseImageMime(json), null);
});

test("Response shows the image on Auto and the bytes once Hex is chosen", () => {
  const entry = response({ mime: "", bytes: SAMPLES["image/png"], encoding: "base64" });
  assert.equal(bodyShowsImage(entry, "response"), true);
  entry._bodyLang = { payload: "auto", response: "hex" };
  assert.equal(bodyShowsImage(entry, "response"), false);
});

test("only the Response tab of a loaded base64 body shows an image", () => {
  const entry = response({ mime: "image/png", bytes: SAMPLES["image/png"], encoding: "base64" });
  assert.equal(bodyShowsImage(entry, "payload"), false);
  const unloaded = response({ mime: "image/png", bytes: SAMPLES["image/png"], encoding: "base64" });
  unloaded._rawResponseBody = undefined;
  assert.equal(bodyShowsImage(unloaded, "response"), false);
  const textual = response({ mime: "image/png", text: "not base64 binary" });
  assert.equal(bodyShowsImage(textual, "response"), false);
});
