// Pure source map lookup (generated -> original position) over retained v3 mappings. No DOM,
// Chrome or panel state access. All lines and columns are zero-based, as in the source map
// format and in Chrome call frames; callers convert to editor coordinates once, at the edge.
// Classic script: defines the SourceMapLookup global.
"use strict";

const SourceMapLookup = (() => {
  const BASE64 = new Int8Array(128).fill(-1);
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    .split("")
    .forEach((char, value) => {
      BASE64[char.charCodeAt(0)] = value;
    });
  const SEMICOLON = 59;
  const COMMA = 44;

  // A section is one leaf map placed at (line, column) of the generated file: an ordinary map
  // is a single section at 0,0, an index map contributes one per `sections` entry. `keys`
  // parallels the map's `sources`: an opaque identifier of the retained source, or null.
  // Only the mappings string is kept (no names, no sourcesContent).
  function createSection({ mappings, keys, line = 0, column = 0 }) {
    return {
      line,
      column,
      mappings: typeof mappings === "string" ? mappings : "",
      keys: Array.isArray(keys) ? keys : [],
      index: null,
    };
  }

  // Reads one base64 VLQ value at reader.pos. Returns NaN when the data is malformed.
  function readVlq(reader) {
    const text = reader.text;
    let result = 0;
    let scale = 1;
    for (let digits = 0; digits < 8; digits++) {
      if (reader.pos >= text.length) return NaN;
      const code = text.charCodeAt(reader.pos++);
      const digit = code < 128 ? BASE64[code] : -1;
      if (digit < 0) return NaN;
      result += (digit & 31) * scale;
      if (!(digit & 32)) return (result % 2 === 1 ? -(result - 1) / 2 : result / 2) + 0;
      scale *= 32;
    }
    return NaN;
  }

  function atSegmentEnd(reader) {
    if (reader.pos >= reader.text.length) return true;
    const code = reader.text.charCodeAt(reader.pos);
    return code === COMMA || code === SEMICOLON;
  }

  // Reads the source/line/column (and optional name) fields that follow a segment's generated
  // column, updating `state`. Returns false for malformed segments (field counts 2 and 3).
  function readOriginalFields(reader, state) {
    const source = readVlq(reader);
    if (Number.isNaN(source) || atSegmentEnd(reader)) return false;
    const line = readVlq(reader);
    if (Number.isNaN(line) || atSegmentEnd(reader)) return false;
    const column = readVlq(reader);
    if (Number.isNaN(column)) return false;
    if (!atSegmentEnd(reader) && Number.isNaN(readVlq(reader))) return false;
    state.source += source;
    state.line += line;
    state.column += column;
    return true;
  }

  // Records, for every generated line, where it starts in the mappings string and the
  // cumulative source/line/column state at that point, so a lookup decodes only one line.
  // Returns null for malformed mappings.
  function buildIndex(section) {
    const reader = { text: section.mappings, pos: 0 };
    const state = { source: 0, line: 0, column: 0 };
    const lines = [{ pos: 0, source: 0, line: 0, column: 0 }];
    while (reader.pos < reader.text.length) {
      const code = reader.text.charCodeAt(reader.pos);
      if (code === SEMICOLON) {
        reader.pos++;
        lines.push({
          pos: reader.pos,
          source: state.source,
          line: state.line,
          column: state.column,
        });
        continue;
      }
      if (code === COMMA) {
        reader.pos++;
        continue;
      }
      if (Number.isNaN(readVlq(reader))) return null;
      if (atSegmentEnd(reader)) continue;
      if (!readOriginalFields(reader, state)) return null;
    }
    return lines;
  }

  // Segment with the greatest generated column <= `column` on `line`, same line only. Returns
  // null when the line has no such segment, when that segment maps nowhere (a one-field
  // segment) or when the data is malformed.
  function lookupInSection(section, line, column) {
    if (section.index === null) section.index = buildIndex(section) || false;
    const lines = section.index;
    if (!lines || line < 0 || line >= lines.length || column < 0) return null;

    const checkpoint = lines[line];
    const reader = { text: section.mappings, pos: checkpoint.pos };
    const state = { source: checkpoint.source, line: checkpoint.line, column: checkpoint.column };
    let generatedColumn = 0;
    let best = null;
    while (reader.pos < reader.text.length) {
      const code = reader.text.charCodeAt(reader.pos);
      if (code === SEMICOLON) break;
      if (code === COMMA) {
        reader.pos++;
        continue;
      }
      const delta = readVlq(reader);
      if (Number.isNaN(delta)) return null;
      generatedColumn += delta;
      if (generatedColumn > column) break;
      if (atSegmentEnd(reader)) {
        best = { mapped: false };
        continue;
      }
      if (!readOriginalFields(reader, state)) return null;
      best = { mapped: true, source: state.source, line: state.line, column: state.column };
    }
    if (!best || !best.mapped) return null;
    if (best.source < 0 || best.source >= section.keys.length) return null;
    if (best.line < 0 || best.column < 0) return null;
    return { key: section.keys[best.source] ?? null, line: best.line, column: best.column };
  }

  // Original position for a generated position, or null when the retained mappings say
  // nothing about it. `key` is the retained source's identifier, null when that source was
  // not retained.
  function originalPosition(sections, line, column) {
    if (!Array.isArray(sections)) return null;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return null;
    let found = null;
    for (const section of sections) {
      const before = section.line < line || (section.line === line && section.column <= column);
      if (before) found = section;
    }
    if (!found) return null;
    const sectionLine = line - found.line;
    const sectionColumn = line === found.line ? column - found.column : column;
    return lookupInSection(found, sectionLine, sectionColumn);
  }

  // Start of a nested section in the outer map's generated coordinates.
  function composeOffset(parentLine, parentColumn, offsetLine, offsetColumn) {
    return {
      line: parentLine + offsetLine,
      column: offsetLine === 0 ? parentColumn + offsetColumn : offsetColumn,
    };
  }

  return { createSection, originalPosition, composeOffset };
})();
