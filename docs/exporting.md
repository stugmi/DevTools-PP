# Exporting

Save individual files, directories, source groups, or the whole capture as an archive.

Choose **ZIP** or **TAR** in the toolbar before exporting, or set the default [Archive format](settings.md#archive-format).

| Scope         | Action                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| One file      | Right-click a file and choose **Export file**                          |
| One directory | Right-click a folder and choose **Export directory**                   |
| One section   | Click **Export** in the Authored, Deployed, or Requests section header |
| Everything    | Click **Export All**, or right-click and choose **Export all sources** |

Section and directory exports respect the [source filter](usage.md#filter-and-group-files), and so does **Export All**. Turn the filter off to export everything. Request [filters](network.md#filters) in the Network list apply only to request exports.

To format exported files with your [Code Formatting](settings.md#code-formatting) style, turn on [Pretty-format files on export](settings.md#pretty-format-files-on-export). Edits made in the [editor](editor.md) are used by Copy and Export.

## Request snapshots

Request exports include available capture time, duration, resource type, URL and query parameters, method, headers, cookies, payload, response status, response headers, timing, MIME types, and response content.

JSON and URL-encoded bodies are structured automatically. Other text stays unchanged; binary response data is preserved as base64. Response content is loaded from the DevTools cache when the request is exported, if it has not already been opened.

See [network requests](network.md) for inspection views and body-loading limits.
