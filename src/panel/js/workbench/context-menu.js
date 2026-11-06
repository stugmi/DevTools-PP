// Data-driven source/request actions, including the keyboard-accessible Copy as submenu.
"use strict";

let contextMenuReturnFocus = null;
let contextSubmenu = null;
let contextSubmenuTrigger = null;

// The requests a request menu acts on in batch, as [path, entry] in list order. The network
// table fixes them when the menu opens (target.requests); other callers get the clicked one.
function contextRequestBatch(target) {
  if (target.requests) return target.requests;
  const entry = state.requestTree[target.path];
  return entry ? [[target.path, entry]] : [];
}

function requestCountLabel(count) {
  return count === 1 ? "request" : `${count} requests`;
}

async function copyRequestCode(entries, format) {
  const code = RequestCode.serialize(format, entries, { lineWidth: prefs.requestCodeLineWidth });
  if (!(await copyTextToClipboard(code))) throw new Error("Copy failed: clipboard unavailable");
}

function contextMenuActions(target) {
  const { type, path, section, domain } = target;
  const actions = [];
  const request = section === "requests" && type === "file";
  // Captured now so later selection changes cannot alter what the async actions work on.
  const batch = request ? contextRequestBatch(target) : [];
  const batchItems = batch.map(([batchPath]) => ({ path: batchPath, section: "requests" }));
  const batchEntries = batch.map(([, entry]) => entry);
  const url = request ? state.requestTree[path]?._record?.request?.url || "" : "";
  if (/^https?:\/\//i.test(url)) {
    actions.push({
      id: "ctx-open-request-url",
      label: "Open in new tab",
      run: () => chrome.tabs.create({ url }),
    });
  }
  if (request) {
    actions.push({
      id: "ctx-show-initiator",
      label: "Show initiator",
      run: () => RequestInitiator.show(path),
    });
  }
  if (type === "file") {
    actions.push({
      id: "ctx-export-file",
      label: request ? "Export " + requestCountLabel(batch.length) : "Export file",
      run: () =>
        request
          ? exportItems(
              batchItems,
              batchItems.length === 1
                ? path.split("/").pop()
                : getDomainLabel() + "-selected-requests"
            )
          : exportItems([{ path, section }], path.split("/").pop()),
    });
  } else if (type === "dir") {
    actions.push({
      id: "ctx-export-dir",
      label: "Export directory",
      run: () =>
        exportItems(
          getItemsUnderDir(section, path, domain),
          path.split("/").pop() || domain || getDomainLabel()
        ),
    });
  } else if (type === "section") {
    const name = section === "mapped" ? "Authored" : section === "raw" ? "Deployed" : "Requests";
    actions.push({
      id: "ctx-export-section",
      label: "Export " + name,
      run: () => exportItems(getItemsInSection(section), archiveNameForSection(section)),
    });
  }
  if (type === "dir" || type === "section") {
    for (const [id, label, open] of [
      ["ctx-collapse-all", "Collapse all folders", false],
      ["ctx-expand-all", "Expand all folders", true],
    ]) {
      actions.push({
        id,
        label,
        run: () =>
          setTreeFoldState(
            section,
            type === "dir" ? path : "",
            open,
            type === "dir" ? domain : undefined
          ),
      });
    }
  }
  if (type === "file" || type === "dir") {
    actions.push({
      id: "ctx-copy-path",
      label: request ? "Copy address" : type === "dir" ? "Copy folder path" : "Copy file path",
      async run() {
        const text = url || path || domain;
        if (text && !(await copyTextToClipboard(text)))
          throw new Error("Copy failed: clipboard unavailable");
      },
    });
  }
  if (request) {
    const preferred =
      RequestCode.FORMATS.find(({ value }) => value === prefs.requestCopyFormat) ||
      RequestCode.FORMATS[0];
    actions.push({
      id: "ctx-copy-preferred",
      label:
        (batch.length === 1 ? "Copy as " : `Copy ${requestCountLabel(batch.length)} as `) +
        preferred.label,
      run: () => copyRequestCode(batchEntries, preferred.value),
    });
    actions.push({
      id: "ctx-copy-as",
      label: "Copy as",
      children: RequestCode.FORMATS.map(({ value, label }) => ({
        id: "ctx-copy-" + value,
        label,
        run: () => copyRequestCode(batchEntries, value),
      })),
    });
  }
  actions.push(null, {
    id: "ctx-export-all",
    label: "Export all sources",
    run: () => exportItems(getAllItems(), getDomainLabel()),
  });
  return actions;
}

function positionContextMenu(menu, x, y) {
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + "px";
}

function closeContextSubmenu(restoreFocus = true) {
  if (!contextSubmenu) return false;
  const trigger = contextSubmenuTrigger;
  contextSubmenu.remove();
  contextSubmenu = null;
  contextSubmenuTrigger = null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
  return true;
}

function openContextSubmenu(trigger, actions, focus = true) {
  if (contextSubmenuTrigger === trigger) {
    if (focus) contextSubmenu.querySelector(".ctx-item")?.focus();
    return;
  }
  closeContextSubmenu(false);
  contextSubmenu = document.createElement("div");
  contextSubmenu.id = "context-submenu";
  contextSubmenu.className = "context-submenu";
  contextSubmenu.setAttribute("role", "menu");
  contextSubmenu.setAttribute("aria-label", "Copy request as");
  contextSubmenuTrigger = trigger;
  contextSubmenu.append(...actions.map(contextActionElement));
  document.body.append(contextSubmenu);
  contextSubmenu.addEventListener("keydown", contextMenuKeydown);
  trigger.setAttribute("aria-expanded", "true");
  const rect = trigger.getBoundingClientRect();
  const fitsRight = rect.right + contextSubmenu.offsetWidth + 4 <= window.innerWidth;
  positionContextMenu(
    contextSubmenu,
    fitsRight ? rect.right : rect.left - contextSubmenu.offsetWidth,
    rect.top
  );
  if (focus) contextSubmenu.querySelector(".ctx-item")?.focus();
}

function contextActionElement(action) {
  if (!action) {
    const separator = document.createElement("div");
    separator.className = "ctx-separator";
    separator.setAttribute("role", "separator");
    return separator;
  }
  const item = document.createElement("button");
  item.type = "button";
  item.id = action.id;
  item.className = "ctx-item";
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  item.textContent = action.label;
  if (action.children) {
    item.classList.add("ctx-submenu-trigger");
    item.setAttribute("aria-haspopup", "menu");
    item.setAttribute("aria-controls", "context-submenu");
    item.setAttribute("aria-expanded", "false");
    const arrow = document.createElement("span");
    arrow.textContent = ">";
    arrow.setAttribute("aria-hidden", "true");
    item.append(arrow);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      openContextSubmenu(item, action.children);
    });
    item.addEventListener("pointerenter", () => openContextSubmenu(item, action.children, false));
    item.addEventListener("keydown", (event) => {
      if (!Keybinds.matches(event, "menu.child")) return;
      event.preventDefault();
      event.stopPropagation();
      openContextSubmenu(item, action.children);
    });
  } else {
    item.addEventListener("pointerenter", () => {
      if (item.parentElement === el.contextMenu) closeContextSubmenu(false);
    });
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      hideContextMenu();
      Promise.resolve()
        .then(action.run)
        .catch((error) => setStatus("inactive", error.message));
    });
  }
  return item;
}

function contextMenuKeydown(event) {
  const menu = event.currentTarget;
  const items = [...menu.querySelectorAll(".ctx-item")];
  const index = items.indexOf(document.activeElement);
  let step;
  if (Keybinds.matches(event, "list.next")) step = 1;
  else if (Keybinds.matches(event, "list.previous")) step = -1;
  else if (Keybinds.matches(event, "menu.parent") && menu === contextSubmenu) closeContextSubmenu();
  else if (Keybinds.matches(event, "item.activate")) items[index]?.click();
  else if (event.key === "Tab") {
    hideContextMenu();
    return;
  } else return;
  if (step) {
    const from = index < 0 ? (step > 0 ? -1 : 0) : index;
    items[(from + step + items.length) % items.length]?.focus();
  }
  event.preventDefault();
  event.stopPropagation();
}

function showContextMenu(x, y, targetType) {
  hideContextMenu();
  const target = state.contextTarget;
  if (!target) return;
  contextMenuReturnFocus = document.activeElement;
  el.contextMenu.replaceChildren(
    ...contextMenuActions({ ...target, type: targetType }).map(contextActionElement)
  );
  el.contextMenu.setAttribute(
    "aria-label",
    target.section === "requests" ? "Request actions" : "File actions"
  );
  el.contextMenu.style.display = "block";
  positionContextMenu(el.contextMenu, x, y);
  el.contextMenu.querySelector(".ctx-item")?.focus();
}

function hideContextMenu() {
  if (el.contextMenu.style.display === "none") return;
  const active = document.activeElement;
  const focusLost =
    !active ||
    active === document.body ||
    el.contextMenu.contains(active) ||
    contextSubmenu?.contains(active);
  closeContextSubmenu(false);
  el.contextMenu.style.display = "none";
  const target = contextMenuReturnFocus;
  contextMenuReturnFocus = null;
  if (focusLost && target?.isConnected) target.focus();
}

el.contextMenu.addEventListener("keydown", contextMenuKeydown);
document.addEventListener("click", (event) => {
  if (!el.contextMenu.contains(event.target) && !contextSubmenu?.contains(event.target))
    hideContextMenu();
});
