# Source Exporter

A Chrome DevTools extension that reconstructs original files from source maps and
exports captured sources and requests as ZIP or TAR archives.

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
- [Releases and changelogs](docs/releases.md)
