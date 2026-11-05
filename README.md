# Source Exporter — Chrome DevTools Extension

Export reconstructed source files from DevTools source maps as ZIP or TAR archives.

## What it does

When a page loads JavaScript with source maps (`.map` files or inline `//# sourceMappingURL=data:...`), Chrome DevTools can show you the original pre-transpile source files under the **Sources > Authored** section. This extension lets you **export those reconstructed sources** — entire directories or the full site — as an archive.

## Installing (Developer Mode)

Build once first:

```powershell
bun install
bun run build
```

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the generated `source-exporter/dist/` folder
5. The extension will appear in your toolbar

## Development tooling

Run `bun install` (or `bun install --frozen-lockfile` in CI) to install dependencies and the
pinned Bun tooling binary. Scripts resolve the local canary, so a global canary upgrade is not required.

```sh
bun run lint          # Bun native lint
bun run lint:fix      # Bun native lint autofixes
bun run format       # Bun native formatter
bun run format:check # Check formatting without writing
bun run check        # TypeScript, lint, formatting and build
```

Tooling uses `bun@1.4.4-canary.20261105.1`, pinned in `package.json` and `bun.lock`. Bun 1.4.4
stable has the formatter but not the native linter. CI uses stable Bun to bootstrap the frozen
install, then runs the pinned canary from `node_modules` for project scripts.

[`bun fmt`](https://bun.com/docs/format) reads `bunfig.toml`.
[`bun lint`](https://bun.com/docs/lint) reads the supported `eslint.config.js` format, including
the panel's shared-global declarations. `@eslint/js` supplies rule settings and `globals` supplies
browser/Node names; neither runs the ESLint engine. ESLint, Prettier and their plugins are not
installed. Bun installs dependencies and runs all project scripts. TypeScript remains the type checker.

The repository no longer forces the VS Code ESLint/Prettier extensions. Run the commands above
for the same checks used by CI.

Successful release builds recreate the rolling `latest` release so GitHub's publication date
matches the build. The tag and download URLs stay the same; release IDs and reactions do not.

## Usage

1. Open DevTools on the target page (`F12`)
2. Click the **Source Exporter** tab in the DevTools panel row
3. Sources populate automatically — no Connect step, no debugger banner
4. Reload the page if scripts loaded before DevTools was open

Enable **Collect navigations** to retain captured files while the inspected page reloads or navigates.
The mode stays enabled until toggled off, letting later routes and lazy requests add to the same
collection. Turning it off keeps the current collection visible; the next navigation returns to the
normal single-page reset behavior. The refresh button always starts a fresh collection.

Use **Settings → Location filter** to show only one exact domain, a domain and its subdomains, or
locations matching a regular expression. The filter affects the tree, counts, and section exports;
**Export All** ignores the location filter and keeps its existing Mapped/Raw toggle behavior.

### Exporting

| Action               | How                                                                         |
| -------------------- | --------------------------------------------------------------------------- |
| Export a single file | Right-click a file → **Export file**                                        |
| Export a directory   | Right-click a folder → **Export directory**                                 |
| Export one section   | Click **Export** in the Authored, Deployed, or Requests section header      |
| Export everything    | Click **Export All** in the header, or right-click → **Export all sources** |
| Preview a file       | Left-click it in the tree                                                   |

### Editing and navigation

- Monaco provides editable source models, syntax highlighting, completion, bracket guides, and minimap.
- Press **Ctrl+F** or click **Find** to search the current file.
- Press **Ctrl+Shift+H** or click **Search all** for grouped, live results across every captured file. Results include highlighted context and jump to the exact match.
- Press **Ctrl+Shift+F** (or **Shift+Alt+F**) to toggle pretty-formatting of the open file or request body.
- Press **Ctrl+B**, **Ctrl+J** or **Ctrl+Alt+B** to toggle the left side bar, bottom panel or right side bar, and **Ctrl+,** to toggle Settings.
- Press **Ctrl+P** to open any captured file by name.
- Press **Ctrl+Shift+P** to open the Source Exporter command palette.
- The command palette also lists Settings: toggle boolean options such as Sticky Scroll directly, or open other settings by name.
- Hold **Ctrl** and click a symbol, or press **F12**, to jump to its closest preceding declaration or assignment.
- Press **Shift+F12** or click **References** to list references across captured website files.
- With a request selected, press **↑** / **↓** to move through the request list and **Alt+←** / **Alt+→** to cycle the Headers, Payload, Preview, Response, Cookies, and Timing tabs (outside the Network workspace they cycle the open editor tabs).
- Press **Esc** to dismiss the front-most layer: an open menu, the Settings window, then the request view. Once nothing is left to close, Esc reaches DevTools and toggles its drawer as usual.
- Source Exporter shortcuts only apply while its DevTools panel has focus. All of them are defined in `src/panel/js/core/keybinds.js`.
- Edited content is used by Copy and Export and marked with a dot in its tab.

The sidebar separates source-mapped files under **Authored**, deployed files under **Deployed**, and
completed network activity under **Requests**. Requests use a newest-first list instead of a file
tree. Filter the list by domain, type (**JS**, **XHR**, **Socket**, **Wasm**, or **Other**), method,
and minimum/maximum duration.

Request rows have **Open in new tab** (opens the URL in a browser tab) and **Copy address** in
their context menu. Files and Network keep separate list selections; changing request filters
keeps a matching selected request highlighted and brings it into view.

Selecting a request opens dedicated **Headers**, **Payload**, **Preview**, **Response**, **Cookies**,
and **Timing** views. **Raw** switches headers between parsed and wire-oriented text. Payload and
Response bodies toggle between **Source** (highlighted, optionally pretty-formatted text) and
**Parsed**, a collapsible tree of JSON values or of the HTML/XML document. **Preview** appears for
HTML, SVG, and image responses and renders them in a sandboxed frame with scripts disabled.

Each export snapshot includes capture time, duration, resource type, URL/query parameters, request
method, headers, cookies, payload, response status, response headers, timing data, MIME types, and
available response content. JSON and URL-encoded bodies are structured automatically; other text
stays unchanged, and binary response data is preserved as base64.

Response content is requested from the DevTools cache only when its **Response** or **Preview** view
is opened or the request is exported. Socket streams retain their handshake metadata without trying
to read an unbounded streaming body.

Choose **ZIP** or **TAR** format in the toolbar before exporting.

## How it works

The extension uses `chrome.devtools.inspectedWindow.getResources()` plus `onResourceAdded` to
passively observe scripts the inspected page loads. The panel does no capture or resource work while
another DevTools tab is active. When visible, script inspection is debounced until navigation
activity settles; each script tail is then scanned for a `sourceMappingURL`, and embedded
`sourcesContent` is reconstructed. No `chrome.debugger` attach is performed, so there is **no "Source
Exporter started debugging this browser" banner**.

Map content is read from the DevTools resource cache when available (no extra network request,
bypasses CORS). Otherwise the panel falls back to a direct `fetch()` using the extension's
`<all_urls>` host permission.

Runtime extension files live under `src/`. `bun run build` creates a clean unpacked extension in `dist/` and adds Monaco's local runtime assets; no remote scripts are used.

```
src/
  devtools/js/        DevTools page that registers the panel
  panel/css/          Panel styles, one file per area (linked in order from panel.html)
  panel/js/core/      Keybinds, shared state and the pre-paint theme script
  panel/js/lib/       File type, language and pretty-print helpers
  panel/js/capture/   Resource discovery, source maps, raw and request capture
  panel/js/editor/    Monaco loader, source editor and read-only body viewer
  panel/js/sources/   Sources tree
  panel/js/network/   Network table, request detail, bodies and cookies
  panel/js/settings/  Settings window and app settings
  panel/js/workbench/ Layout, tabs and preview, search, export, keyboard dispatch
  panel/js/main.js    Event wiring and startup (loaded last)
```

Panel scripts are plain `<script>` tags sharing one global scope, so their order in `panel.html` matters.

## Notes

- Only files with **embedded source content** (`sourcesContent` in the map) are exportable. Files referenced by path only show in the tree but can't be saved.
- Scripts loaded before DevTools was opened may be missed by `onResourceAdded` — reload the page to capture them.
- TAR uses ustar with a `prefix` field for paths >100 chars; paths over 255 chars fall back to truncated filename only.

## Limitations

- Cross-origin maps still require the page to actually load them. If DevTools didn't fetch the map (e.g. source maps disabled in DevTools settings), the fallback `fetch()` from the extension origin must succeed instead.
