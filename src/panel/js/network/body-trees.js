// Parsed-view trees for request/response bodies: a JSON tree and an HTML/XML markup tree.
// Loaded after request-body.js; requestDetailEmpty (request-detail.js) is only used at render time.

"use strict";

// -- Shared tree branch --

// Wide arrays/objects render this many children at a time ("Show next N").
const JSON_CHUNK_SIZE = 200;

// A collapsible tree node: a toggle row plus a child host whose content is built on first
// expand, so a large document stays cheap until explored. `rowContent` follows the toggle in
// the row; `buildChildren(childHost)` returns the child nodes. Returns the node's wrapper.
function createTreeBranch(rowContent, buildChildren, { label = "", expanded = false } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "json-node json-node--branch";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "json-toggle";
  toggle.setAttribute("aria-label", `Toggle ${label}`.trim());
  const row = document.createElement("div");
  row.className = "json-row";
  row.append(toggle, ...rowContent);

  const childHost = document.createElement("div");
  childHost.className = "json-children collapsed";

  let built = false;
  const setExpanded = (open) => {
    if (open && !built) {
      built = true;
      childHost.append(...buildChildren(childHost));
    }
    childHost.classList.toggle("collapsed", !open);
    row.classList.toggle("expanded", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  row.addEventListener("click", () => setExpanded(!row.classList.contains("expanded")));
  setExpanded(expanded);

  wrapper.append(row, childHost);
  return wrapper;
}

// -- JSON tree (Parsed mode for object/array bodies) --

function jsonValuePreview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  const shown = keys.slice(0, 3).join(", ");
  return `{${shown}${keys.length > 3 ? ", …" : ""}}`;
}

function appendJsonScalar(row, value) {
  const big = typeof value === "bigint";
  const span = document.createElement("span");
  span.className = `json-value json-value-${value === null ? "null" : big ? "number" : typeof value}`;
  span.textContent =
    value === undefined ? "undefined" : big ? String(value) : JSON.stringify(value);
  row.appendChild(span);
}

// Nodes for children `from`.. of an object/array (`keys` is null for arrays), at most one chunk,
// followed by a "Show next" button when more remain.
function jsonChunk(host, value, keys, from) {
  const total = keys ? keys.length : value.length;
  const to = Math.min(from + JSON_CHUNK_SIZE, total);
  const nodes = [];
  for (let i = from; i < to; i++) {
    const key = keys ? keys[i] : i;
    nodes.push(buildJsonNode(key, value[key]));
  }
  if (to < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "json-more";
    more.textContent = `Show next ${Math.min(JSON_CHUNK_SIZE, total - to)} of ${total - to} more`;
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      more.remove();
      host.append(...jsonChunk(host, value, keys, to));
    });
    nodes.push(more);
  }
  return nodes;
}

function jsonKeys(value) {
  return Array.isArray(value) ? null : Object.keys(value);
}

function buildJsonNode(key, value) {
  const keyNodes = [];
  if (key != null) {
    const keySpan = document.createElement("span");
    keySpan.className = "json-key";
    keySpan.textContent = `${key}: `;
    keyNodes.push(keySpan);
  }

  if (value === null || typeof value !== "object") {
    const wrapper = document.createElement("div");
    wrapper.className = "json-node";
    const row = document.createElement("div");
    row.className = "json-row";
    const spacer = document.createElement("span");
    spacer.className = "json-toggle-spacer";
    row.append(spacer, ...keyNodes);
    appendJsonScalar(row, value);
    wrapper.appendChild(row);
    return wrapper;
  }

  const preview = document.createElement("span");
  preview.className = "json-preview";
  preview.textContent = jsonValuePreview(value);
  return createTreeBranch(
    [...keyNodes, preview],
    (host) => jsonChunk(host, value, jsonKeys(value), 0),
    { label: String(key ?? "root") }
  );
}

function buildJsonTree(value) {
  const container = document.createElement("div");
  container.className = "json-tree";
  if (value === null || typeof value !== "object") {
    container.appendChild(buildJsonNode(null, value));
    return container;
  }
  const keys = jsonKeys(value);
  if ((keys ? keys.length : value.length) === 0) {
    container.appendChild(
      requestDetailEmpty(Array.isArray(value) ? "Empty array" : "Empty object")
    );
    return container;
  }
  container.append(...jsonChunk(container, value, keys, 0));
  return container;
}

// A tree host holding only a message (size limit, build failure).
function buildNoticeTree(message) {
  const container = document.createElement("div");
  container.className = "json-tree";
  container.appendChild(requestDetailEmpty(message));
  return container;
}

// The built tree for a tab, kept until its parsed result changes so re-renders (wrap, format,
// tab switches) preserve the expanded nodes.
function bodyTreeFor(entry, tab, parsed) {
  const cache = (entry._bodyTree ??= {});
  const hit = cache[tab];
  if (hit && hit.parsed === parsed) return hit.tree;
  let tree;
  try {
    if (parsed.kind === "json") tree = buildJsonTree(parsed.value);
    else if (parsed.kind === "markup") tree = buildMarkupTree(parsed);
    else tree = buildNoticeTree(parsed.message);
  } catch (error) {
    tree = buildNoticeTree(
      error instanceof RangeError
        ? "Too deeply nested to display. Switch to Source."
        : `Could not build the parsed view: ${error.message}`
    );
  }
  cache[tab] = { parsed, tree };
  return tree;
}

// -- Markup tree (Parsed mode for HTML/XML bodies) --

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function markupSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

// Child nodes worth a row: elements, non-blank text, comments, CDATA and processing
// instructions. Indentation-only text nodes are dropped.
function markupChildren(node) {
  return Array.from(node.childNodes).filter((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.data.trim() !== "";
    return [
      Node.ELEMENT_NODE,
      Node.CDATA_SECTION_NODE,
      Node.COMMENT_NODE,
      Node.PROCESSING_INSTRUCTION_NODE,
      Node.DOCUMENT_TYPE_NODE,
    ].includes(child.nodeType);
  });
}

function markupTagName(element, isHtml) {
  return isHtml ? element.localName : element.nodeName;
}

// `<name attr="value">` (or `<name attr="value"/>` when `selfClose`) as one inline span.
function markupOpenTag(element, isHtml, selfClose = false) {
  const tag = document.createElement("span");
  tag.className = "markup-tag";
  tag.append(
    markupSpan("markup-bracket", "<"),
    markupSpan("markup-name", markupTagName(element, isHtml))
  );
  for (const attr of element.attributes) {
    tag.append(" ", markupSpan("markup-attr", attr.name));
    tag.append(markupSpan("markup-bracket", '="'));
    tag.append(markupSpan("markup-attr-value", attr.value));
    tag.append(markupSpan("markup-bracket", '"'));
  }
  tag.append(markupSpan("markup-bracket", selfClose ? "/>" : ">"));
  return tag;
}

function markupCloseTag(element, isHtml) {
  const tag = document.createElement("span");
  tag.className = "markup-tag";
  tag.append(
    markupSpan("markup-bracket", "</"),
    markupSpan("markup-name", markupTagName(element, isHtml)),
    markupSpan("markup-bracket", ">")
  );
  return tag;
}

function markupLeafText(node) {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
      return markupSpan("json-value-string", node.data.trim());
    case Node.CDATA_SECTION_NODE:
      return markupSpan("json-value-string", `<![CDATA[${node.data}]]>`);
    case Node.COMMENT_NODE:
      return markupSpan("markup-comment", `<!--${node.data}-->`);
    case Node.PROCESSING_INSTRUCTION_NODE:
      return markupSpan("markup-comment", `<?${node.target} ${node.data}?>`);
    case Node.DOCUMENT_TYPE_NODE:
      return markupSpan("markup-comment", `<!DOCTYPE ${node.name}>`);
    default:
      return markupSpan("markup-comment", node.textContent);
  }
}

function markupRow(...content) {
  const row = document.createElement("div");
  row.className = "json-row";
  row.append(...content);
  return row;
}

function markupSpacer() {
  return markupSpan("json-toggle-spacer", "");
}

// One DOM node of the tree. Elements whose only content is text stay on one line; others
// expand to their children plus a closing-tag row. Children are built on first expand so a
// large document stays cheap until explored.
function buildMarkupNode(node, isHtml, expanded = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "json-node";
  if (node.nodeType !== Node.ELEMENT_NODE) {
    wrapper.appendChild(markupRow(markupSpacer(), markupLeafText(node)));
    return wrapper;
  }

  const children = markupChildren(node);
  const name = markupTagName(node, isHtml);
  if (children.length === 0) {
    const selfClose = !isHtml;
    const row = markupRow(markupSpacer(), markupOpenTag(node, isHtml, selfClose));
    if (isHtml && !HTML_VOID_ELEMENTS.has(name)) {
      row.lastChild.appendChild(markupCloseTag(node, isHtml));
    }
    wrapper.appendChild(row);
    return wrapper;
  }
  const onlyText =
    children.length === 1 &&
    (children[0].nodeType === Node.TEXT_NODE || children[0].nodeType === Node.CDATA_SECTION_NODE);
  if (onlyText) {
    const line = markupOpenTag(node, isHtml);
    line.append(markupLeafText(children[0]), markupCloseTag(node, isHtml));
    wrapper.appendChild(markupRow(markupSpacer(), line));
    return wrapper;
  }

  const preview = document.createElement("span");
  preview.className = "json-preview";
  preview.textContent = `…</${name}>`;
  const branch = createTreeBranch(
    [markupOpenTag(node, isHtml), preview],
    () => children.map((child) => buildMarkupNode(child, isHtml)),
    { label: name, expanded }
  );

  const close = markupRow(markupSpacer(), markupCloseTag(node, isHtml));
  close.classList.add("markup-close");
  branch.appendChild(close);
  return branch;
}

// The document's top-level nodes (doctype, comments, root element), with the root element
// expanded like the JSON tree's root properties.
function buildMarkupTree({ doc, isHtml, error }) {
  const container = document.createElement("div");
  container.className = "json-tree";
  if (error) {
    container.appendChild(requestDetailEmpty(`Could not parse XML: ${error}`));
    return container;
  }
  for (const node of markupChildren(doc)) {
    container.appendChild(buildMarkupNode(node, isHtml, node === doc.documentElement));
  }
  return container;
}
