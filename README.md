# Source Exporter — Chrome DevTools Extension

Export reconstructed source files from DevTools source maps as ZIP or TAR archives.

## What it does

When a page loads JavaScript with source maps (`.map` files or inline `//# sourceMappingURL=data:...`), Chrome DevTools can show you the original pre-transpile source files under the **Sources > Authored** section. This extension lets you **export those reconstructed sources** — entire directories or the full site — as an archive.

## Installing (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`source-exporter/`)
5. The extension will appear in your toolbar

## Usage

1. Open DevTools on the target page (`F12`)
2. Click the **Source Exporter** tab in the DevTools panel row
3. Sources populate automatically — no Connect step, no debugger banner
4. Reload the page if scripts loaded before DevTools was open

### Exporting

| Action               | How                                                            |
| -------------------- | -------------------------------------------------------------- |
| Export a single file | Right-click a file → **Export file**                           |
| Export a directory   | Right-click a folder → **Export directory**                    |
| Export everything    | Click **Export All** in the header, or right-click → **Export all sources** |
| Preview a file       | Left-click it in the tree                                      |

Choose **ZIP** or **TAR** format in the toolbar before exporting.

## How it works

The extension uses `chrome.devtools.inspectedWindow.getResources()` plus `onResourceAdded` to passively observe scripts the inspected page loads. For each script it scans the tail for a `sourceMappingURL` comment, resolves the map URL, and parses `sourcesContent`. No `chrome.debugger` attach is performed, so there is **no "Source Exporter started debugging this browser" banner**.

Map content is read from the DevTools resource cache when available (no extra network request, bypasses CORS). Otherwise the panel falls back to a direct `fetch()` using the extension's `<all_urls>` host permission.

## Notes

- Only files with **embedded source content** (`sourcesContent` in the map) are exportable. Files referenced by path only show in the tree but can't be saved.
- Scripts loaded before DevTools was opened may be missed by `onResourceAdded` — reload the page to capture them.
- TAR uses ustar with a `prefix` field for paths >100 chars; paths over 255 chars fall back to truncated filename only.

## Limitations

- Cross-origin maps still require the page to actually load them. If DevTools didn't fetch the map (e.g. source maps disabled in DevTools settings), the fallback `fetch()` from the extension origin must succeed instead.
- Manifest V3 — no persistent background page is needed since all work happens in the panel context.
