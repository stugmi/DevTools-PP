# Capture and filtering

Source Exporter collects files and completed requests from the inspected page while its DevTools panel is visible.

## Source groups

- **Authored**: original files reconstructed from source maps.
- **Deployed**: files served by the website.
- **Requests**: completed network activity, shown newest first rather than as a tree.

Select a file to open it in the editor, or a request to inspect its details. See [editor and shortcuts](editor.md) and [network requests](network.md).

## Collect across navigations

Enable **Collect navigations** to retain files while the inspected page reloads or navigates. Later routes and lazy requests add to the same collection until you turn the mode off.

Turning it off keeps the current collection; the next navigation returns to single-page capture. The refresh button always starts a fresh collection.

Capture pauses while another DevTools tab is active. Reload the page with Source Exporter visible if scripts loaded before DevTools opened or while the panel was hidden.

## Filter locations

Use **Settings > Location filter** to match one domain, a domain and its subdomains, or a regular expression. This affects the tree, counts, and section exports.

**Export All** ignores the location filter and follows the Mapped/Raw toggles. Request-specific filters are covered in [network requests](network.md).

## Source-map limits

Reconstructed Authored files need embedded `sourcesContent` in the source map. Path-only entries can appear in the tree but cannot be exported as original source.

Cross-origin maps must be available through the DevTools cache or accessible to the extension's fallback fetch. See [how capture works](architecture.md).
