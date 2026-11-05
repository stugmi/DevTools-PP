// Single source of truth for every keyboard shortcut in the panel.
// Loaded before all other panel scripts. Dispatch lives in workbench/keyboard.js.

// -- Keybinds --
// Attempting to replicate the DevTools keybinds and behaviour.
//
// Global (dispatched by keyboard.js)
// [Esc]                Pop the topmost overlay (menu, settings, or request view)
//                      If no overlays are open, pass through to native DevTools
// [Ctrl + Shift + F]   Format the open file or request body
// [Shift + Alt + F]    Same as above (VS Code style)
// [Ctrl + P]           Open the file quick picker
// [Ctrl + Shift + P]   Open the command palette
// [Ctrl + Shift + H]   Search across the workspace
// [Ctrl + ,]           Toggle the settings window
// [Ctrl + B]           Toggle the left side bar
// [Ctrl + J]           Toggle the bottom panel
// [Ctrl + Alt + B]     Toggle the right side bar
// [Alt + Left/Right]   Switch tabs within the front-most view
// [Up/Down]            Select the previous/next request while the request list is in use
//
// Lists and inline editing (handled by their own widgets)
// [Up/Down]            Move the highlight in the quick picker and workspace search results
// [Enter]              Accept the highlighted item (quick picker, search results)
//                      Commit a cookie cell edit
//                      Open a footer URL link
// [Enter / Space]      Open a tree file or toggle a folder or section
// [Left/Right]         Collapse/expand the focused tree folder
// [Shift + F10]        Open the context menu of the focused tree item
// [Arrows]             Resize a focused splitter (Shift for bigger steps)
// [Esc]                Cancel a cookie cell edit or a view drag
//
// Editor
// [F12]                Go to definition (Ctrl + Click works too)
// [Ctrl + F]           Find in the current file (Monaco)
// [Shift + F12]        List references for the symbol (Monaco)
// [Ctrl + Click]       Open a footer link in a new tab
//
// "Ctrl" is the primary modifier: Cmd on Mac, Ctrl elsewhere. Modifiers must match exactly.
// Letters and punctuation also match by physical key (event.code) under Alt and on layouts
// whose characters are not ASCII. Entries marked native are handled by Monaco or the
// browser and are listed here for labels only.

const IS_MAC = /mac/i.test(navigator.platform);

window.Keybinds = (() => {
  const BINDINGS = [
    // Global
    {
      id: "overlay.dismiss",
      keys: ["Esc"],
      description: "Dismiss the topmost overlay",
      scope: "global",
    },
    {
      id: "file.format",
      keys: ["Ctrl+Shift+F", "Shift+Alt+F"],
      description: "Format the open file",
      scope: "global",
    },
    {
      id: "palette.files",
      keys: ["Ctrl+P"],
      description: "Open the file quick picker",
      scope: "global",
    },
    {
      id: "palette.commands",
      keys: ["Ctrl+Shift+P"],
      description: "Open the command palette",
      scope: "global",
    },
    {
      id: "search.workspace",
      keys: ["Ctrl+Shift+H"],
      description: "Search the workspace",
      scope: "global",
    },
    {
      id: "settings.toggle",
      keys: ["Ctrl+,"],
      description: "Toggle the settings window",
      scope: "global",
    },
    {
      id: "view.toggleLeft",
      keys: ["Ctrl+B"],
      description: "Toggle the left side bar",
      scope: "global",
    },
    {
      id: "view.toggleBottom",
      keys: ["Ctrl+J"],
      description: "Toggle the bottom panel",
      scope: "global",
    },
    {
      id: "view.toggleRight",
      keys: ["Ctrl+Alt+B"],
      description: "Toggle the right side bar",
      scope: "global",
    },
    {
      id: "tabs.previous",
      keys: ["Alt+Left"],
      description: "Previous tab in the front-most view",
      scope: "global",
    },
    {
      id: "tabs.next",
      keys: ["Alt+Right"],
      description: "Next tab in the front-most view",
      scope: "global",
    },
    {
      id: "requests.previous",
      keys: ["Up"],
      description: "Select the previous request",
      scope: "global",
    },
    {
      id: "requests.next",
      keys: ["Down"],
      description: "Select the next request",
      scope: "global",
    },

    // Lists and inline editing
    {
      id: "list.previous",
      keys: ["Up"],
      description: "Highlight the previous item",
      scope: "list",
    },
    {
      id: "list.next",
      keys: ["Down"],
      description: "Highlight the next item",
      scope: "list",
    },
    {
      id: "list.accept",
      keys: ["Enter"],
      description: "Accept the highlighted item",
      scope: "list",
    },
    {
      id: "cell.commit",
      keys: ["Enter"],
      description: "Commit a cookie cell edit",
      scope: "list",
    },
    {
      id: "cell.cancel",
      keys: ["Esc"],
      description: "Cancel a cookie cell edit",
      scope: "list",
    },
    {
      id: "item.activate",
      keys: ["Enter", "Space"],
      description: "Open a tree file or toggle a folder or section",
      scope: "list",
    },
    {
      id: "cell.edit",
      keys: ["Enter", "F2"],
      description: "Edit the focused cookie cell",
      scope: "list",
    },
    {
      id: "item.menu",
      keys: ["Shift+F10", "ContextMenu"],
      description: "Open the context menu for the focused item",
      scope: "list",
    },
    {
      id: "tree.expand",
      keys: ["Right"],
      description: "Expand the focused tree folder",
      scope: "list",
    },
    {
      id: "tree.collapse",
      keys: ["Left"],
      description: "Collapse the focused tree folder",
      scope: "list",
    },
    {
      id: "splitter.left",
      keys: ["Left", "Shift+Left"],
      description: "Move a focused splitter left",
      scope: "list",
    },
    {
      id: "splitter.right",
      keys: ["Right", "Shift+Right"],
      description: "Move a focused splitter right",
      scope: "list",
    },
    {
      id: "splitter.up",
      keys: ["Up", "Shift+Up"],
      description: "Move a focused splitter up",
      scope: "list",
    },
    {
      id: "splitter.down",
      keys: ["Down", "Shift+Down"],
      description: "Move a focused splitter down",
      scope: "list",
    },
    {
      id: "link.open",
      keys: ["Enter"],
      description: "Open a footer URL link",
      scope: "list",
    },
    {
      id: "drag.cancel",
      keys: ["Esc"],
      description: "Cancel a view drag",
      scope: "list",
    },

    // Editor
    {
      id: "editor.goToDefinition",
      keys: ["F12", "Ctrl+Click"],
      description: "Go to definition",
      scope: "editor",
    },
    {
      id: "editor.find",
      keys: ["Ctrl+F"],
      description: "Find in the current file",
      scope: "editor",
      native: true,
    },
    {
      id: "editor.findReferences",
      keys: ["Shift+F12"],
      description: "List references",
      scope: "editor",
      native: true,
    },
    {
      id: "link.openInTab",
      keys: ["Ctrl+Click"],
      description: "Open a link in a new tab",
      scope: "editor",
      native: true,
    },
  ];

  const MODIFIERS = new Set(["ctrl", "shift", "alt"]);

  const KEY_ALIASES = {
    esc: "escape",
    space: " ",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
  };

  // Physical keys for chords written with a character, so they still fire when the
  // layout produces a different character (Option on Mac, Cyrillic and other layouts).
  const PUNCTUATION_CODES = {
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "-": "Minus",
    "=": "Equal",
    "`": "Backquote",
    "\\": "Backslash",
  };

  function codeForKey(key) {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return PUNCTUATION_CODES[key] ?? "";
  }

  // Throws on unknown modifiers so a typo in the table fails at startup.
  function parseChord(chord) {
    // A trailing "+" is the key itself ("Ctrl++").
    const plusKey = chord === "+" || chord.endsWith("++");
    const parts = (plusKey ? chord.slice(0, -1) : chord).split("+");
    const key = (plusKey ? "+" : parts.pop()).toLowerCase();
    if (!key) throw new Error(`Invalid keybind "${chord}"`);
    const mods = new Set();
    for (const part of plusKey ? parts.filter(Boolean) : parts) {
      const mod = part.toLowerCase();
      if (!MODIFIERS.has(mod)) throw new Error(`Unknown modifier "${part}" in keybind "${chord}"`);
      mods.add(mod);
    }
    const normalized = KEY_ALIASES[key] ?? key;
    return {
      key: normalized,
      code: codeForKey(normalized),
      pointer: normalized === "click",
      ctrl: mods.has("ctrl"),
      shift: mods.has("shift"),
      alt: mods.has("alt"),
    };
  }

  // Native (Monaco/browser) bindings and pointer chords are listed for labels only.
  const byId = new Map(
    BINDINGS.map((binding) => {
      const parsed = binding.keys.map(parseChord);
      const chords = binding.native ? [] : parsed.filter((chord) => !chord.pointer);
      return [binding.id, { ...binding, chords }];
    })
  );

  function keyMatches(chord, event) {
    const key = event.key?.toLowerCase();
    if (chord.code) {
      const asciiKey = key?.length === 1 && key >= " " && key <= "~";
      if (!asciiKey || event.altKey) return event.code === chord.code;
    }
    return chord.key === key;
  }

  // "Ctrl" in a chord is the primary modifier: Cmd on Mac, Ctrl elsewhere.
  function matches(event, id) {
    const binding = byId.get(id);
    if (!binding) return false;
    const primary = IS_MAC ? event.metaKey : event.ctrlKey;
    const other = IS_MAC ? event.ctrlKey : event.metaKey;
    if (other) return false;
    return binding.chords.some(
      (chord) =>
        chord.ctrl === primary &&
        chord.shift === event.shiftKey &&
        chord.alt === event.altKey &&
        keyMatches(chord, event)
    );
  }

  function display(keys) {
    return IS_MAC ? keys.replace(/\bCtrl\b/g, "⌘") : keys;
  }

  function label(id) {
    return display(byId.get(id)?.keys[0] ?? "");
  }

  function labels(id) {
    return (byId.get(id)?.keys ?? []).map(display);
  }

  // Fills `title` on [data-keybind] elements and the text of [data-keybind-label] ones.
  // The title without the shortcut is remembered so repeated calls don't stack suffixes.
  function applyTitles(root = document) {
    for (const node of root.querySelectorAll("[data-keybind]")) {
      node.dataset.keybindTitle ??= node.title;
      const base = node.dataset.keybindTitle;
      const text = label(node.dataset.keybind);
      node.title = base ? `${base} (${text})` : text;
    }
    for (const node of root.querySelectorAll("[data-keybind-label]")) {
      node.textContent = label(node.dataset.keybindLabel);
    }
  }

  return { matches, label, labels, applyTitles };
})();
