# How it works

Source Exporter passively reconstructs source-map content without attaching a debugger.

## Capture and permissions

`chrome.devtools.inspectedWindow.getResources()` and `onResourceAdded` expose resources loaded by the inspected page. While the panel is visible, inspection is debounced until navigation activity settles. Each script tail is scanned for `sourceMappingURL`, then embedded `sourcesContent` is reconstructed.

No capture or resource work runs while another DevTools tab is active. The extension does not attach through `chrome.debugger`, so it does not show a debugging banner.

Map content is read from the DevTools resource cache when available, avoiding another network request and bypassing CORS. Otherwise the panel attempts a direct fetch using the extension's `<all_urls>` host permission; that fetch must still succeed for the map to be available.

## Source layout

Runtime files live under `src/`. The build adds local Monaco assets to `dist/`; no remote scripts are used.

```text
src/
  devtools/js/        DevTools page that registers the panel
  panel/css/          Panel styles, linked in order from panel.html
  panel/js/core/      Keybinds, shared state, pre-paint theme
  panel/js/lib/       File type, language, pretty-print helpers
  panel/js/capture/   Resource discovery, source maps, raw/request capture
  panel/js/editor/    Monaco loader, source editor, read-only body viewer
  panel/js/sources/   Sources tree
  panel/js/network/   Request table, details, bodies, cookies
  panel/js/settings/  Settings window and app settings
  panel/js/workbench/ Layout, tabs, preview, search, export, keyboard dispatch
  panel/js/main.js    Event wiring and startup, loaded last
```

Panel scripts use plain `<script>` tags in a shared global scope. Their order in `panel.html` matters.

See [capture and filtering](usage.md) for collection behavior and source-map limitations, or [development](development.md) for build commands.
