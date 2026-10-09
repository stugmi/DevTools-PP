# Source Exporter — Chrome DevTools Extension

Export reconstructed source files from DevTools source maps as ZIP or TAR archives.

## What it does

When a page loads JavaScript with source maps (`.map` files or inline `//# sourceMappingURL=data:...`), Chrome DevTools can show you the original pre-transpile source files under the **Sources > Authored** section. This extension lets you **export those reconstructed sources** — entire directories or the full site — as an archive.

## Installing (Developer Mode)

Build once first:

```powershell
npm install
npm run build
```

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the generated `source-exporter/dist/` folder
5. The extension will appear in your toolbar

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
- Press **Ctrl+Shift+F** or click **Search all** for grouped, live results across every captured file. Results include highlighted context and jump to the exact match.
- Press **Ctrl+P** to open any captured file by name.
- Press **Ctrl+Shift+P** to open the Source Exporter command palette.
- Hold **Ctrl** and click a symbol, or press **F12**, to jump to its closest preceding declaration or assignment.
- Press **Shift+F12** or click **References** to list references across captured website files.
- Source Exporter shortcuts only apply while its DevTools panel has focus.
- Edited content is used by Copy and Export and marked with a dot in its tab.

The sidebar separates source-mapped files under **Authored**, deployed files under **Deployed**, and
completed network activity under **Requests**. Requests use a newest-first list instead of a file
tree. Filter the list by domain, type (**JS**, **XHR**, **Socket**, **Wasm**, or **Other**), method,
and minimum/maximum duration.

Selecting a request opens dedicated **Headers**, **Payload**, **Response**, and **Timing** views.
**Raw** switches headers and bodies between parsed and wire-oriented text. Each export snapshot
includes capture time, duration, resource type, URL/query parameters, request method, headers,
cookies, payload, response status, response headers, timing data, MIME types, and available response
content. JSON and URL-encoded bodies are structured automatically; other text stays unchanged, and
binary response data is preserved as base64.

Response content is requested from the DevTools cache only when its **Response** view is opened or
the request is exported. Socket streams retain their handshake metadata without trying to read an
unbounded streaming body.

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

Runtime extension files live under `src/`. `npm run build` creates a clean unpacked extension in `dist/` and adds Monaco's local runtime assets; no remote scripts are used.

## Notes

- Only files with **embedded source content** (`sourcesContent` in the map) are exportable. Files referenced by path only show in the tree but can't be saved.
- Scripts loaded before DevTools was opened may be missed by `onResourceAdded` — reload the page to capture them.
- TAR uses ustar with a `prefix` field for paths >100 chars; paths over 255 chars fall back to truncated filename only.

## Limitations

- Cross-origin maps still require the page to actually load them. If DevTools didn't fetch the map (e.g. source maps disabled in DevTools settings), the fallback `fetch()` from the extension origin must succeed instead.
