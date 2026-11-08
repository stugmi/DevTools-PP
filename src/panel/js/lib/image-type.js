// Raster image type from a body's leading bytes, for responses whose Content-Type is missing,
// generic (application/octet-stream) or wrong. No DOM, no I/O. SVG is text and is detected
// elsewhere. Loaded before request-body.js, which decides what the Response and Preview tabs show.
"use strict";

const ImageType = (() => {
  const ascii = (text) => Array.from(text, (char) => char.charCodeAt(0));
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const GIF87 = ascii("GIF87a");
  const GIF89 = ascii("GIF89a");
  const RIFF = ascii("RIFF");
  const WEBP = ascii("WEBP");
  const FTYP = ascii("ftyp");
  const AVIF_BRANDS = [ascii("avif"), ascii("avis")];
  // DIB header sizes a BMP can declare (BITMAPCOREHEADER up to BITMAPV5HEADER).
  const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
  // Enough leading bytes to tell every supported type apart.
  const HEAD_BYTES = 32;

  function matches(bytes, signature, offset = 0) {
    if (bytes.length < offset + signature.length) return false;
    for (let index = 0; index < signature.length; index++) {
      if (bytes[offset + index] !== signature[index]) return false;
    }
    return true;
  }

  // MIME type for the image whose signature starts `bytes`, or null. Two-byte signatures (BMP,
  // ICO) are only accepted with a plausible header behind them so text and noise are not mistaken
  // for images.
  function sniff(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (matches(bytes, PNG)) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (matches(bytes, GIF87) || matches(bytes, GIF89)) return "image/gif";
    if (matches(bytes, RIFF) && matches(bytes, WEBP, 8)) return "image/webp";
    if (matches(bytes, FTYP, 4) && AVIF_BRANDS.some((brand) => matches(bytes, brand, 8))) {
      return "image/avif";
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 18) {
      const headerSize = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24);
      if (BMP_HEADER_SIZES.has(headerSize)) return "image/bmp";
    }
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && bytes.length >= 6) {
      const count = bytes[4] | (bytes[5] << 8);
      if (count >= 1 && count <= 256) return "image/x-icon";
    }
    return null;
  }

  // Same, for body text that is base64 (how DevTools hands over binary content). Only the first
  // few characters are decoded, so the cost does not depend on the size of the body.
  function sniffBase64(text) {
    if (typeof text !== "string") return null;
    const head = text.slice(0, HEAD_BYTES * 2).replace(/\s+/g, "");
    const usable = head.slice(0, head.length - (head.length % 4));
    if (usable.length < 8) return null;
    let binary;
    try {
      binary = atob(usable);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return sniff(bytes);
  }

  return { sniff, sniffBase64 };
})();
