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
2. Click the **Source Exporter** tab (in the DevTools panel row)
3. Click **Connect to Tab**
4. Navigate or reload the page — scripts with source maps are captured automatically
5. The file tree populates with all reconstructed source paths

### Exporting

| Action | How |
|---|---|
| Export a single file | Right-click a file → **Export file** |
| Export a directory | Right-click a folder → **Export directory** |
| Export everything | Click **Export All** in the header, or right-click → **Export all sources** |
| Preview a file | Left-click it in the tree |

Choose **ZIP** or **TAR** format in the toolbar before exporting.

## Notes

- Only files with **embedded source content** (`sourcesContent` in the map) are exported. Files referenced by path only (where the original source isn't embedded) will show in the tree but can't be saved.
- The debugger must be attached (Connect) before navigating — scripts parsed before attachment are missed. Use **Refresh** (↺) if you reload after connecting.
- The extension uses the Chrome Debugger API (`Debugger.scriptParsed`) to intercept script loads, then fetches and parses each `.map` file.

## Limitations

- Manifest V3 extension — no persistent background page. If DevTools is closed and reopened, click Connect again (or the session may auto-reconnect if scripts are still cached).
- Source maps served from `localhost` require no special permissions. Cross-origin maps depend on CORS headers on the map files.
