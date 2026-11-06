// Validated JSON payload parsing and formatting for request/response bodies: one JSON value, or
// newline-delimited JSON records (two or more object/array values, one per physical line) such as
// the Datadog browser SDK sends for RUM batches. Pure: the text given is never altered.
// parseJsonExact (request-capture.js) and formatJsonText (filetype.js) are looked up at call time.

"use strict";

const JSON_RECORD_START = /^[ \t\r]*[[{]/;
const JSON_BLANK_LINE = /^[ \t\r]*$/;

// The non-blank lines of `text` when it has at least two and each one starts like a JSON object
// or array, else null. A line is not validated here; the caller parses or formats each one, so a
// malformed or truncated record rejects the whole payload instead of being skipped.
function jsonRecordLines(text) {
  const lines = [];
  for (const line of text.split("\n")) {
    if (JSON_BLANK_LINE.test(line)) continue;
    if (!JSON_RECORD_START.test(line)) return null;
    lines.push(line.trim());
  }
  return lines.length >= 2 ? lines : null;
}

// Parses `text` as one JSON value, or as newline-delimited records. Returns
// { value, records } or null when it is neither: `records` is null for a single JSON value and
// otherwise the record lines as sent, with `value` an array of the parsed records. Integers
// beyond 2^53 stay exact (BigInt) in both shapes.
function parseJsonPayload(text) {
  try {
    return { value: parseJsonExact(text), records: null };
  } catch {
    // Not a single JSON value, try records.
  }
  const lines = jsonRecordLines(text);
  if (!lines) return null;
  try {
    return { value: lines.map(parseJsonExact), records: lines };
  } catch {
    return null;
  }
}

// Re-indents `text` as one JSON value, or each record of newline-delimited JSON on its own,
// separated by a blank line so the framing stays visible. The result is a reading view, not
// valid JSON. Throws when the text is neither.
function formatJsonPayloadText(text) {
  try {
    return formatJsonText(text) + "\n";
  } catch (error) {
    const lines = jsonRecordLines(text);
    if (!lines) throw error;
    return lines.map((line) => formatJsonText(line)).join("\n\n") + "\n";
  }
}
