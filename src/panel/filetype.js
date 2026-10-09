"use strict";

const EXT_COLORS = {
  ts: "#4a9eff",
  tsx: "#4a9eff",
  js: "#c4a44a",
  jsx: "#4ab4c4",
  css: "#9b59b6",
  scss: "#c76494",
  sass: "#c76494",
  html: "#e4704a",
  json: "#7aaa60",
  md: "#8aa4b4",
  vue: "#42b883",
  py: "#3572a5",
  rs: "#dea584",
  go: "#00add8",
  java: "#b07219",
  rb: "#701516",
  svelte: "#ff3e00",
};

function fileIcon(ext) {
  const color = EXT_COLORS[ext] || "#7a8b9a";
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 2h6l3 3v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="${color}22" stroke="${color}" stroke-width="0.7"/>
    <path d="M8 2v3h3" stroke="${color}" stroke-width="0.7" fill="none"/>
  </svg>`;
}

// ── Language detection ───────────────────────────────────────────────────────

const EXT_TO_LANGUAGE = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  css: "css",
  scss: "scss",
  sass: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  graphql: "graphql",
  gql: "graphql",
  vue: "html",
  svelte: "html",
  md: "markdown",
};

const LANG_LABELS = {
  javascript: "JS",
  typescript: "TS",
  html: "HTML",
  xml: "XML",
  css: "CSS",
  scss: "SCSS",

  json: "JSON",
  python: "PY",
  rust: "RS",
  go: "GO",
  java: "JAVA",
  kotlin: "KT",
  shell: "SH",
  yaml: "YAML",
  graphql: "GQL",
  markdown: "MD",
};

function detectLang(path) {
  const ext = extensionForPath(path);
  return EXT_TO_LANGUAGE[ext] || null;
}

function langFromContentType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "text/javascript" || mime === "application/javascript") return "javascript";
  if (mime === "text/css") return "css";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) return "xml";
  return null;
}

function detectEntryLang(path, entry) {
  return (
    detectLang(path) ||
    langFromContentType(entry && entry.contentType) ||
    sniffLang(entry && entry.content)
  );
}

function sniffLang(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return null;
    }
  }
  return null;
}

function extensionForPath(path) {
  const basename = (path || "").split("/").pop() || "";
  const dot = basename.lastIndexOf(".");
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1).toLowerCase() : "";
}

function badgeForPath(path, lang) {
  if (lang && LANG_LABELS[lang]) return LANG_LABELS[lang];
  const ext = extensionForPath(path);
  return ext ? ext.toUpperCase() : "TXT";
}

const BEAUTIFY_OPTS = {
  indent_size: 2,
  end_with_newline: true,
  preserve_newlines: true,
  max_preserve_newlines: 2,
};

function getBeautifier() {
  if (typeof window === "undefined") return null;
  if (window.beautifier) return window.beautifier;
  if (window.js_beautify || window.css_beautify || window.html_beautify) {
    return {
      js: window.js_beautify,
      css: window.css_beautify,
      html: window.html_beautify,
    };
  }
  return null;
}

function canPrettyFormat(lang) {
  if (!lang) return false;
  if (lang === "json") return true;
  const b = getBeautifier();
  if (!b) return false;
  return ["javascript", "typescript", "css", "scss", "html", "xml"].includes(lang);
}

// Re-indents JSON text without round-tripping it through JSON.parse/stringify,
// so big integers (ids, timestamps) and key order are kept byte-for-byte.
// Throws if `text` isn't valid JSON.
function formatJsonText(text, indent = "  ") {
  JSON.parse(text);
  const length = text.length;
  const whitespace = /\s/;
  let out = "";
  let depth = 0;
  let i = 0;
  const newline = () => "\n" + indent.repeat(depth);
  while (i < length) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (char === "{" || char === "[") {
      let next = i + 1;
      while (next < length && whitespace.test(text[next])) next++;
      if (text[next] === (char === "{" ? "}" : "]")) {
        out += char + text[next];
        i = next + 1;
      } else {
        depth++;
        out += char + newline();
        i++;
      }
    } else if (char === "}" || char === "]") {
      depth--;
      out += newline() + char;
      i++;
    } else if (char === ",") {
      out += "," + newline();
      i++;
    } else if (char === ":") {
      out += ": ";
      i++;
    } else {
      if (!whitespace.test(char)) out += char;
      i++;
    }
  }
  return out;
}

function prettyFormat(content, lang) {
  if (lang === "json") {
    return formatJsonText(content) + "\n";
  }
  const b = getBeautifier();
  if (!b) throw new Error("beautifier unavailable");
  if (lang === "javascript" || lang === "typescript") {
    return b.js(content, BEAUTIFY_OPTS);
  }
  if (lang === "css" || lang === "scss") {
    return b.css(content, BEAUTIFY_OPTS);
  }
  if (lang === "html") {
    return b.html(content, BEAUTIFY_OPTS);
  }
  throw new Error("no formatter for " + lang);
}

function commentHeader(lang, lines) {
  if (lang === "json") return null; // JSON has no comments
  if (lang === "html") {
    return "<!--\n" + lines.map((l) => "  " + l).join("\n") + "\n-->\n\n";
  }
  if (lang === "python" || lang === "yaml" || lang === "shell") {
    return lines.map((l) => "# " + l).join("\n") + "\n\n";
  }
  // js, ts, css, scss, default
  return "/*\n" + lines.map((l) => " * " + l).join("\n") + "\n */\n\n";
}

function tryPretty(content, lang) {
  if (!canPrettyFormat(lang)) return { ok: false, content, reason: "Unsupported file type" };
  try {
    return { ok: true, content: prettyFormat(content, lang) };
  } catch (e) {
    return { ok: false, content, reason: e && e.message ? e.message : String(e) };
  }
}

function updatePrettyButton(lang) {
  if (!el.btnPretty) return;
  const supported = canPrettyFormat(lang);
  el.btnPretty.disabled = !supported;
  el.btnPretty.classList.toggle("active", state.prettyView && supported);
  el.btnPretty.title = supported
    ? state.prettyView
      ? "Showing pretty-formatted version (click for original)"
      : "Pretty-format this file"
    : "No formatter available for this file type";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "apng"]);

function isImagePath(path, entry) {
  const ext = path.split(".").pop().toLowerCase();
  if (IMAGE_EXTS.has(ext)) return true;
  if (entry && entry.type === "image") return true;
  return false;
}

function isTextEntry(path, entry) {
  if (isImagePath(path, entry)) return false;
  if (["font", "media"].includes(entry?.type)) return false;
  return !/^(?:image|audio|video|font)\//i.test(entry?.contentType || "");
}
