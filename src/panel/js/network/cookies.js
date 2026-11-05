// Cookies tab: table with inline cell editing (double-click, or Enter/F2 on a focused cell),
// plus copy/save in common formats.
// Edits change only the captured copy of the request (table, copy/save output, exported JSON),
// never the page's cookies; the raw Cookie / Set-Cookie header text stays as captured.
// Loaded before request-detail.js, which provides requestDetailPanel and requestDetailSection.

"use strict";

const COOKIE_COLUMNS = [
  { key: "name", label: "Name", title: "Name", type: "text" },
  { key: "value", label: "Value", title: "Value", type: "text" },
  { key: "path", label: "Path", title: "Path", type: "text" },
  { key: "domain", label: "Domain", title: "Domain", type: "text" },
  { key: "expires", label: "Expires", title: "Expires", type: "text" },
  { key: "httpOnly", label: "H", title: "HttpOnly", type: "bool" },
  { key: "secure", label: "S", title: "Secure", type: "bool" },
  {
    key: "sameSite",
    label: "SameSite",
    title: "SameSite",
    type: "select",
    options: ["", "None", "Lax", "Strict"],
  },
];

// -- Export formats --

function cookieHostFor(entry) {
  try {
    return new URL(entry._record.request.url).hostname;
  } catch {
    return "";
  }
}

// Epoch milliseconds, or null for a session cookie or unparsable date.
function cookieExpiryMs(cookie) {
  if (!cookie.expires) return null;
  const ms = Date.parse(cookie.expires);
  return Number.isFinite(ms) ? ms : null;
}

function cookieSameSiteJson(value) {
  const lower = String(value || "").toLowerCase();
  if (lower === "none") return "no_restriction";
  if (lower === "lax" || lower === "strict") return lower;
  return "unspecified";
}

const COOKIE_FORMATS = {
  json: {
    label: "JSON (Cookie-Editor)",
    ext: "json",
    mime: "application/json",
    build(cookies, host) {
      return (
        JSON.stringify(
          cookies.map((cookie) => {
            const expiry = cookieExpiryMs(cookie);
            const domain = cookie.domain || host;
            return {
              domain,
              ...(expiry == null ? {} : { expirationDate: expiry / 1000 }),
              hostOnly: !domain.startsWith("."),
              httpOnly: Boolean(cookie.httpOnly),
              name: cookie.name,
              path: cookie.path || "/",
              sameSite: cookieSameSiteJson(cookie.sameSite),
              secure: Boolean(cookie.secure),
              session: expiry == null,
              storeId: "0",
              value: cookie.value ?? "",
            };
          }),
          null,
          2
        ) + "\n"
      );
    },
  },
  netscape: {
    label: "Netscape cookies.txt",
    ext: "txt",
    mime: "text/plain",
    build(cookies, host) {
      const lines = ["# Netscape HTTP Cookie File", ""];
      for (const cookie of cookies) {
        const domain = cookie.domain || host;
        const expiry = cookieExpiryMs(cookie);
        lines.push(
          [
            (cookie.httpOnly ? "#HttpOnly_" : "") + domain,
            domain.startsWith(".") ? "TRUE" : "FALSE",
            cookie.path || "/",
            cookie.secure ? "TRUE" : "FALSE",
            expiry == null ? 0 : Math.floor(expiry / 1000),
            cookie.name,
            cookie.value ?? "",
          ].join("\t")
        );
      }
      return lines.join("\n") + "\n";
    },
  },
  header: {
    label: "Cookie header",
    ext: "txt",
    mime: "text/plain",
    build: (cookies) => cookies.map((c) => `${c.name}=${c.value ?? ""}`).join("; ") + "\n",
  },
  setcookie: {
    label: "Set-Cookie lines",
    ext: "txt",
    mime: "text/plain",
    build(cookies) {
      return (
        cookies
          .map((cookie) => {
            const parts = [`${cookie.name}=${cookie.value ?? ""}`];
            const expiry = cookieExpiryMs(cookie);
            if (expiry != null) parts.push(`Expires=${new Date(expiry).toUTCString()}`);
            if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
            if (cookie.path) parts.push(`Path=${cookie.path}`);
            if (cookie.secure) parts.push("Secure");
            if (cookie.httpOnly) parts.push("HttpOnly");
            if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
            return `Set-Cookie: ${parts.join("; ")}`;
          })
          .join("\n") + "\n"
      );
    },
  },
};

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // DevTools panels can deny the async clipboard API, so fall back to execCommand.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function currentCookieFormat() {
  return COOKIE_FORMATS[state.cookieFormat] ? state.cookieFormat : "json";
}

// -- Editing --

// Original values of cookies the user has edited. Kept out of the cookie objects so they
// never end up in the exported request JSON.
const cookieOriginals = new WeakMap();

// Remember how a cookie looked before its first edit. Must run before the new value is
// assigned.
function snapshotCookie(cookie) {
  if (!cookieOriginals.has(cookie)) cookieOriginals.set(cookie, { ...cookie });
}

// A cookie whose fields all match the captured values again is no longer "modified".
function dropSnapshotIfUnchanged(cookie) {
  const original = cookieOriginals.get(cookie);
  if (original && COOKIE_COLUMNS.every((column) => cookie[column.key] === original[column.key])) {
    cookieOriginals.delete(cookie);
  }
}

function cookiesModified(cookies) {
  return cookies.some((cookie) => cookieOriginals.has(cookie));
}

function resetCookieEdits(cookies) {
  for (const cookie of cookies) {
    const original = cookieOriginals.get(cookie);
    if (!original) continue;
    Object.assign(cookie, original);
    cookieOriginals.delete(cookie);
  }
}

function commitCookieEdit(entry, cookie, column, value) {
  if (cookie[column.key] === value) return false;
  if (column.key === "name" && !String(value).trim()) return false; // a cookie needs a name
  snapshotCookie(cookie);
  cookie[column.key] = value;
  dropSnapshotIfUnchanged(cookie);
  invalidateRequestContent(entry);
  return true;
}

// `cellIndex` is the cell's position in the panel; pass it for keyboard-started edits so focus
// returns to the same cell after the table re-renders.
function renderCookiesPanelKeepingFocus(entry, cellIndex) {
  renderCookiesPanel(entry);
  if (cellIndex >= 0) {
    requestDetailPanel("cookies")?.querySelectorAll(".cookie-cell")[cellIndex]?.focus();
  }
}

function beginCookieEdit(cell, entry, cookie, column, keyboard = false) {
  if (cell.classList.contains("editing")) return;
  const cellIndex = keyboard
    ? Array.from(requestDetailPanel("cookies")?.querySelectorAll(".cookie-cell") || []).indexOf(
        cell
      )
    : -1;

  if (column.type === "bool") {
    commitCookieEdit(entry, cookie, column, !cookie[column.key]);
    renderCookiesPanelKeepingFocus(entry, cellIndex);
    return;
  }

  const original = cookie[column.key] ?? "";
  let control;
  if (column.type === "select") {
    control = document.createElement("select");
    for (const option of column.options) {
      control.add(new Option(option || "(none)", option));
    }
    if (!column.options.includes(original)) control.add(new Option(original, original), 0);
    control.value = original;
  } else {
    control = document.createElement("input");
    control.type = "text";
    control.spellcheck = false;
    control.value = original;
  }
  control.className = "cookie-edit";
  cell.classList.add("editing");
  cell.replaceChildren(control);
  control.focus();
  if (control.select) control.select();

  let finished = false;
  const finish = (save, refocus = false) => {
    if (finished) return;
    finished = true;
    const changed = save && commitCookieEdit(entry, cookie, column, control.value);
    if (changed) renderCookiesPanelKeepingFocus(entry, refocus ? cellIndex : -1);
    else {
      cell.classList.remove("editing");
      cell.textContent = original;
      if (refocus) cell.focus();
    }
  };
  control.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (Keybinds.matches(event, "cell.commit")) finish(true, true);
    else if (Keybinds.matches(event, "cell.cancel")) finish(false, true);
  });
  control.addEventListener("blur", () => finish(true));
  if (column.type === "select") control.addEventListener("change", () => finish(true));
}

// -- Rendering --

function cookieDisplayValue(cookie, column) {
  const value = cookie[column.key];
  if (column.type === "bool") return value ? "✓" : "";
  return value == null ? "" : String(value);
}

function cookieTable(cookies, entry) {
  const table = document.createElement("div");
  table.className = "cookie-table";
  const head = document.createElement("div");
  head.className = "cookie-row cookie-head";
  for (const column of COOKIE_COLUMNS) {
    const cell = document.createElement("span");
    cell.textContent = column.label;
    cell.title = column.title;
    head.appendChild(cell);
  }
  table.appendChild(head);

  for (const cookie of cookies) {
    const row = document.createElement("div");
    row.className = "cookie-row cookie-data";
    row.classList.toggle("modified", cookieOriginals.has(cookie));
    for (const column of COOKIE_COLUMNS) {
      const cell = document.createElement("span");
      cell.className = `cookie-cell${column.key === "name" ? " cookie-name" : ""}${
        column.type === "bool" ? " cookie-flag" : ""
      }`;
      cell.textContent = cookieDisplayValue(cookie, column);
      const hint = `double-click or Enter to ${column.type === "bool" ? "toggle" : "edit"}`;
      cell.title =
        column.type === "bool"
          ? `${column.title}: ${hint}`
          : `${cell.textContent}\n(${hint})`.trim();
      cell.tabIndex = 0;
      cell.addEventListener("dblclick", (event) => {
        event.preventDefault();
        beginCookieEdit(cell, entry, cookie, column);
      });
      cell.addEventListener("keydown", (event) => {
        if (event.target !== cell || !Keybinds.matches(event, "cell.edit")) return;
        event.preventDefault();
        event.stopPropagation();
        beginCookieEdit(cell, entry, cookie, column, true);
      });
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  return table;
}

function cookieActionButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-sm btn-ghost cookie-action";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// Format picker, Copy, Save (and Reset edits once something changed) for one cookie list,
// shown on the right of its section header.
function cookieSectionActions(entry, kind, cookies) {
  const wrap = document.createElement("div");
  wrap.className = "cookie-actions";

  const select = document.createElement("select");
  select.className = "cookie-format";
  select.title = "Format for Copy and Save";
  select.setAttribute("aria-label", "Cookie export format");
  for (const [id, format] of Object.entries(COOKIE_FORMATS)) {
    select.add(new Option(format.label, id));
  }
  select.value = currentCookieFormat();
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    state.cookieFormat = select.value;
    renderCookiesPanel(entry);
  });

  const build = () => COOKIE_FORMATS[currentCookieFormat()].build(cookies, cookieHostFor(entry));

  wrap.append(
    select,
    cookieActionButton("Copy", "Copy these cookies in the selected format", async (button) => {
      flashButton(button, (await copyTextToClipboard(build())) ? "Copied" : "Failed");
    }),
    cookieActionButton("Save", "Save these cookies as a file in the selected format", (button) => {
      const format = COOKIE_FORMATS[currentCookieFormat()];
      const host = cookieHostFor(entry) || "cookies";
      const blob = new Blob([build()], { type: `${format.mime};charset=utf-8` });
      triggerDownload(blob, `${host}-${kind}-cookies.${format.ext}`);
      flashButton(button, "Saved");
    })
  );

  if (cookiesModified(cookies)) {
    wrap.appendChild(
      cookieActionButton("Reset edits", "Restore the cookies as they were captured", () => {
        resetCookieEdits(cookies);
        invalidateRequestContent(entry);
        renderCookiesPanel(entry);
      })
    );
  }
  return wrap;
}

function requestCookies(entry) {
  const { request, response } = entry._record;
  return { request: request.cookies || [], response: response.cookies || [] };
}

function renderCookiesPanel(entry) {
  const panel = requestDetailPanel("cookies");
  if (!panel) return;
  panel.replaceChildren();
  const cookies = requestCookies(entry);
  for (const [title, kind] of [
    ["Request cookies", "request"],
    ["Response cookies", "response"],
  ]) {
    const list = cookies[kind];
    if (!list.length) continue;
    panel.appendChild(
      requestDetailSection(title, cookieTable(list, entry), {
        actions: cookieSectionActions(entry, kind, list),
      })
    );
  }
}
