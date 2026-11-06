# Source Exporter

An alternative source and network workspace inside Chrome DevTools for debugging,
reverse engineering, and inspecting web pages.

I built it because Chromium's DevTools was missing features I'd wanted for a while,
starting with exporting files detected through source maps. I've tried to keep the
familiar DevTools behavior first, then add new features and quality-of-life improvements.

## Features

- Source inspection
  - ZIP and TAR exports
    - Source-mapped and raw files, folders, domains, or whole captures
  - Monaco code editor
    - Basic code completion, go to definition, and find references
    - Syntax highlighting and formatting
    - Minimap navigation and editor options in Settings
  - Search across all captured files
- Network request inspection
  - Filtering, sorting, and request timestamps
  - Headers, payloads, responses, cookies, and timing details
    - Source, parsed, and hex body views, with sandboxed previews
  - Copy as Python (requests/httpx), browser/Node.js fetch, PowerShell, or cURL
    - Copy or export multiple selected requests
    - Preferred replay format and line width in Settings
  - Initiator call stacks with source navigation
- Workspace customization
  - Dockable panels and alternative themes
  - VS Code-style command palette and searchable settings

## Install

1. Download and unzip [the latest build](https://github.com/stugmi/SourceExporter/releases/download/latest/source-exporter.zip).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

To build from source, see [development](docs/development.md).

## Quick start

1. Open DevTools on the page you want to inspect and select **Source Exporter**.
2. Reload the page if its scripts loaded before the panel was open.
3. Select a file or request to inspect it, then use **Export All** to save the capture.

## Documentation

- [Capture and filtering](docs/usage.md)
- [Exporting files and requests](docs/exporting.md)
- [Editor and keyboard shortcuts](docs/editor.md)
- [Network requests](docs/network.md)
- [Development](docs/development.md)
- [How it works](docs/architecture.md)
- [Changelogs](changelogs/)
