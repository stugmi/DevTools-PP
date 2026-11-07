// Source filter: file type classification, the comma separated include/exclude pattern language
// and the matcher built from it. Pure (no DOM, no panel state), so it is tested on its own.
//
// Patterns are separated by commas or new lines and matched case-insensitively:
//   *.js  src/**  github.com  react   glob, path or plain text (see compileUnqualified)
//   .min.js                           file name ending
//   ext:js  type:style  domain:cdn.example.com  path:src/components  file:Ago  url:https://x/*
//   /regex/flags                      regular expression on the path and URLs
"use strict";

const SourceFilter = (() => {
  const FILE_TYPES = Object.freeze([
    { id: "js", label: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"] },
    { id: "ts", label: "TypeScript", exts: ["ts", "tsx", "mts", "cts"] },
    { id: "style", label: "Styles", exts: ["css", "scss", "sass", "less", "styl", "pcss"] },
    {
      id: "html",
      label: "HTML & templates",
      exts: ["html", "htm", "xhtml", "vue", "svelte", "astro", "hbs", "ejs", "pug"],
    },
    {
      id: "data",
      label: "JSON & data",
      exts: ["json", "jsonc", "json5", "map", "yaml", "yml", "xml", "csv", "toml"],
    },
    {
      id: "image",
      label: "Images",
      exts: ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "apng", "cur"],
    },
    { id: "font", label: "Fonts", exts: ["woff", "woff2", "ttf", "otf", "eot"] },
    {
      id: "media",
      label: "Audio & video",
      exts: ["mp4", "webm", "mp3", "ogg", "oga", "ogv", "wav", "m4a", "m4v", "mov", "flac", "aac"],
    },
    { id: "wasm", label: "WebAssembly", exts: ["wasm"] },
    { id: "other", label: "Other", exts: [] },
  ]);

  const TYPE_BY_EXT = new Map();
  for (const type of FILE_TYPES) for (const ext of type.exts) TYPE_BY_EXT.set(ext, type.id);

  // Names accepted after `type:` besides the ids themselves.
  const TYPE_ALIASES = {
    javascript: "js",
    script: "js",
    scripts: "js",
    typescript: "ts",
    styles: "style",
    css: "style",
    template: "html",
    templates: "html",
    json: "data",
    images: "image",
    img: "image",
    fonts: "font",
    audio: "media",
    video: "media",
  };

  const QUALIFIERS = {
    ext: "ext",
    type: "type",
    domain: "domain",
    host: "domain",
    path: "path",
    folder: "path",
    file: "file",
    name: "file",
    url: "url",
  };

  function nameOf(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function extOf(path) {
    const name = nameOf(path);
    const dot = name.lastIndexOf(".");
    return dot === -1 || name.length === 1 ? "" : name.slice(dot + 1).toLowerCase();
  }

  function typeOf(path) {
    return TYPE_BY_EXT.get(extOf(path)) || "other";
  }

  function typeLabel(id) {
    return FILE_TYPES.find((type) => type.id === id)?.label ?? id;
  }

  // What the rules are tested against: the explorer path plus the URLs the file came from.
  function makeTarget(path, urls, host) {
    const lowerPath = path.toLowerCase();
    const rawUrls = urls.filter(Boolean);
    return {
      path,
      lowerPath,
      lowerName: nameOf(lowerPath),
      ext: extOf(path),
      type: typeOf(path),
      host: (host || "").toLowerCase(),
      rawUrls,
      urls: rawUrls.map((url) => url.toLowerCase()),
    };
  }

  // -- Pattern language --

  const REGEX_TOKEN =
    /\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+)\/([a-z]*)(?=[ \t]*(?:[,\n]|$))/y;

  // Splits filter text into raw rules. A `/regex/flags` rule may contain commas.
  function tokenize(text) {
    const tokens = [];
    const length = text.length;
    let i = 0;
    while (i < length) {
      while (i < length && (text[i] === "," || /\s/.test(text[i]))) i++;
      if (i >= length) break;
      if (text[i] === "/") {
        REGEX_TOKEN.lastIndex = i;
        const match = REGEX_TOKEN.exec(text);
        if (match) {
          tokens.push({ raw: match[0], regex: { body: match[1], flags: match[2] } });
          i = REGEX_TOKEN.lastIndex;
          continue;
        }
      }
      let end = i;
      while (end < length && text[end] !== "," && text[end] !== "\n") end++;
      const raw = text.slice(i, end).trim();
      if (raw) tokens.push({ raw });
      i = end + 1;
    }
    return tokens;
  }

  function hasWildcard(value) {
    return /[*?]/.test(value);
  }

  function escapeRegExp(text) {
    return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  // `*` and `?` stay inside one path segment, `**` crosses `/`. With `anySlash`, `*` crosses it
  // too (URLs, host names). Returns the regex source without anchors.
  function globSource(glob, anySlash) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i];
      if (char === "*") {
        if (glob[i + 1] === "*") {
          const slash = glob[i + 2] === "/";
          out += slash ? "(?:.*/)?" : ".*";
          i += slash ? 2 : 1;
        } else {
          out += anySlash ? ".*" : "[^/]*";
        }
      } else if (char === "?") {
        out += anySlash ? "." : "[^/]";
      } else {
        out += escapeRegExp(char);
      }
    }
    return out;
  }

  // Matches the whole text, or with `tail` a tail of a path that starts at a folder boundary.
  function globMatcher(glob, { anySlash = false, tail = false } = {}) {
    const re = new RegExp(`^${tail ? "(?:.*/)?" : ""}${globSource(glob, anySlash)}$`, "s");
    return (text) => re.test(text);
  }

  function normalizeHostPattern(value) {
    return value
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z\d+.-]*:\/\//, "")
      .split("/")[0]
      .replace(/:\d+$/, "")
      .replace(/^\.+|\.+$/g, "");
  }

  function hostMatcher(value) {
    const pattern = normalizeHostPattern(value);
    if (!pattern) return null;
    if (hasWildcard(pattern)) {
      const test = globMatcher(pattern, { anySlash: true });
      return (target) => Boolean(target.host) && test(target.host);
    }
    return (target) =>
      Boolean(target.host) && (target.host === pattern || target.host.endsWith(`.${pattern}`));
  }

  // Substring of any text, or a glob over any text when the pattern has wildcards.
  function textMatcher(value, getTexts, globOptions) {
    const pattern = value.trim().toLowerCase();
    if (!pattern) return null;
    if (hasWildcard(pattern)) {
      const test = globMatcher(pattern, globOptions);
      return (target) => getTexts(target).some(test);
    }
    return (target) => getTexts(target).some((text) => text.includes(pattern));
  }

  // A `|` separated qualifier value becomes several alternatives.
  function anyOf(value, build) {
    const matchers = [];
    for (const part of value.split("|")) {
      const matcher = build(part);
      if (matcher) matchers.push(matcher);
    }
    if (!matchers.length) return null;
    return (target) => matchers.some((matcher) => matcher(target));
  }

  function compileQualified(qualifier, value) {
    if (!value.trim()) return { error: `Nothing after "${qualifier}:"` };
    switch (qualifier) {
      case "ext":
        return {
          test: anyOf(value, (part) => {
            const ext = part.trim().toLowerCase().replace(/^\./, "");
            if (!ext) return null;
            if (!hasWildcard(ext)) return (target) => target.ext === ext;
            const test = globMatcher(ext, { anySlash: true });
            return (target) => Boolean(target.ext) && test(target.ext);
          }),
        };
      case "type": {
        const ids = [];
        for (const part of value.split("|")) {
          const key = part.trim().toLowerCase();
          if (!key) continue;
          const id = FILE_TYPES.some((type) => type.id === key) ? key : TYPE_ALIASES[key];
          if (!id) return { error: `Unknown file type "${key}"` };
          ids.push(id);
        }
        return { test: (target) => ids.includes(target.type) };
      }
      case "domain":
        return { test: anyOf(value, hostMatcher) };
      case "path":
        return {
          test: anyOf(value, (part) =>
            textMatcher(part, (target) => [target.lowerPath], { tail: true })
          ),
        };
      case "file":
        return {
          test: anyOf(value, (part) =>
            textMatcher(part, (target) => [target.lowerName], { anySlash: true })
          ),
        };
      default:
        return {
          test: anyOf(value, (part) =>
            textMatcher(part, (target) => target.urls, { anySlash: true })
          ),
        };
    }
  }

  function compileUnqualified(raw) {
    const pattern = raw.toLowerCase();
    if (!hasWildcard(pattern)) {
      // `.min.js` is a file name ending; anything else is a substring of the path or a URL.
      if (pattern.startsWith(".") && pattern.length > 1 && !pattern.includes("/")) {
        return { test: (target) => target.lowerName.endsWith(pattern) };
      }
      return {
        test: (target) =>
          target.lowerPath.includes(pattern) || target.urls.some((url) => url.includes(pattern)),
      };
    }
    if (pattern.includes("://")) {
      const test = globMatcher(pattern, { anySlash: true });
      return { test: (target) => target.urls.some(test) };
    }
    if (pattern.includes("/")) {
      const test = globMatcher(pattern, { tail: true });
      return { test: (target) => test(target.lowerPath) };
    }
    // No slash: a file name or a host name.
    const test = globMatcher(pattern, { anySlash: true });
    return {
      test: (target) => test(target.lowerName) || (Boolean(target.host) && test(target.host)),
    };
  }

  function compileRegex({ body, flags }) {
    try {
      // No flags means case-insensitive; explicit flags are used as given (minus stateful ones).
      const re = new RegExp(body, flags ? flags.replace(/[gy]/g, "") : "i");
      return {
        test: (target) => re.test(target.path) || target.rawUrls.some((url) => re.test(url)),
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // Returns { test(target) } or { error }.
  function compileRule(token) {
    if (token.regex) return compileRegex(token.regex);
    const qualified = /^([a-z]+):(?!\/\/)(.*)$/i.exec(token.raw);
    const name = qualified?.[1].toLowerCase();
    const qualifier = name && Object.hasOwn(QUALIFIERS, name) ? QUALIFIERS[name] : null;
    const compiled = qualifier
      ? compileQualified(qualifier, qualified[2])
      : compileUnqualified(token.raw);
    if (!compiled.error && !compiled.test) return { error: "Empty pattern" };
    return compiled;
  }

  // Compiles filter text into rules. Invalid rules are dropped and reported in `errors`.
  function compile(text) {
    const rules = [];
    const errors = [];
    for (const token of tokenize(text || "")) {
      const rule = compileRule(token);
      if (rule.error) errors.push({ rule: token.raw, message: rule.error });
      else rules.push({ raw: token.raw, test: rule.test });
    }
    return { rules, errors };
  }

  // The filter used by the panel. A file passes when it matches an include rule (or there are
  // none) and no exclude rule. `active` is false when disabled or without any valid rule, so
  // callers can skip filtering entirely.
  function createFilter({ enabled = true, include = "", exclude = "" } = {}) {
    const included = compile(include);
    const excluded = compile(exclude);
    const ruleCount = included.rules.length + excluded.rules.length;
    const active = Boolean(enabled) && ruleCount > 0;
    return {
      enabled: Boolean(enabled),
      active,
      ruleCount,
      includeErrors: included.errors,
      excludeErrors: excluded.errors,
      hasErrors: included.errors.length + excluded.errors.length > 0,
      matches(target) {
        if (!active) return true;
        if (included.rules.length && !included.rules.some((rule) => rule.test(target))) {
          return false;
        }
        return !excluded.rules.some((rule) => rule.test(target));
      },
    };
  }

  // -- Editing helpers for the quick-pick chips --

  function hasToken(text, token) {
    const wanted = token.toLowerCase();
    return tokenize(text || "").some((entry) => entry.raw.toLowerCase() === wanted);
  }

  // Adds `token` to the filter text, or removes it when already there.
  function toggleToken(text, token) {
    const wanted = token.toLowerCase();
    const raws = tokenize(text || "").map((entry) => entry.raw);
    const kept = raws.filter((raw) => raw.toLowerCase() !== wanted);
    if (kept.length === raws.length) kept.push(token);
    return kept.join(", ");
  }

  return {
    FILE_TYPES,
    typeOf,
    typeLabel,
    extOf,
    makeTarget,
    tokenize,
    compile,
    createFilter,
    hasToken,
    toggleToken,
  };
})();
