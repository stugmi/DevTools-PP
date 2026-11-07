# Changelog

## 1.5.2

### Changes

- Rename Source Exporter to **DevTools++** in the extension, panel, popup, settings, and documentation. Release downloads use `devtools-plus-plus.zip` and `devtools-plus-plus.crx`.

### Developer Information

- Add `bun run dev` for a [live standalone panel preview][live-panel], automatically reloading source changes without rebuilding or reloading the extension. A local simulated capture populates the editor and Network views without an inspected tab.
- Add `bun run screenshots` to [refresh all eight documentation images][screenshots] from the current dev panel and its local demo configuration in an isolated headless renderer.

[live-panel]: https://github.com/stugmi/SourceExporter/blob/main/docs/development.md#live-panel-preview
[screenshots]: https://github.com/stugmi/SourceExporter/blob/main/docs/development.md#documentation-screenshots

## 1.5.1

### Bug Fixes

- Fix malformed extension icons so PNG decoders can load them correctly.

## 1.5.0

### New Features

- [Filter source files][source-filter] from the new **Filter** button in the Files toolbar: comma separated include and exclude rules (globs such as `*.js, src/**`, domains, folders, file types, `/regex/`), one-click shortcut chips, a switch that pauses the filter without clearing it, and a status bar summary. Rules are saved between sessions.
- [Group the explorer][group-files] by domain, by file type, or not at all, and choose whether files nest in folders, from the filter popover or **Settings > Source Filter**.
- Configure pretty-formatting in **Settings > [Code Formatting][code-formatting]**: brace and object style, array layout, indent size or tabs, blank-line limits, and line wrapping. The style applies to previews, request bodies, and formatted exports.
- [Pause or resume watching][pause-watching] the page by clicking the status bar dot or from its right-click menu. Captured files stay; resuming catches up with the page.
- [Copy as][copy-as] expands JSON request bodies into readable Python and fetch structures, including string values that hold JSON text at any depth (written as `stringify(...)` or `JSON.stringify(...)`). It works with non-JSON content types such as `text/plain`, keeps the captured Content-Type, and only expands values that re-serialize to the exact captured bytes.
- Choose how Python writes embedded JSON in **Settings > Network > [Embedded JSON in Python][embedded-json]**: a `stringify(...)` helper function declared above the request (default), the same helper bound inline as `(stringify := lambda v: ...)`, or inline `json.dumps(...)` calls.

### Changes

- Pretty-formatting keeps short imports, objects, and blocks on one line in code that is already formatted, such as source-mapped files, instead of splitting each across lines. Minified code is still fully expanded; choose **Always expand** in [Braces and objects][braces] for the previous layout.
- [Network filter bar][network-filters]: **Method** sits next to the text filter, and the domain filter is a **Domains** button with a searchable list, request counts, and a removable chip for the active domain. Requests also offer **Filter to this domain** in their right-click menu.
- Python replays of JSON-in-text bodies need `json` imported, and the walrus helper option needs Python 3.8 or newer. Python sends the structure with `json=` only for JSON content types.
- [Copy as][copy-as] keeps each header, and each string value inside JSON and form structures, on one line instead of splitting long values such as `User-Agent` or page URLs into concatenated pieces.
- [Replay line width][line-width] defaults to 120 columns instead of 88 and has no upper limit; the minimum stays 40.
- [Copy as][copy-as] PowerShell writes text bodies as readable UTF-8 text and JSON bodies as `[ordered]@{...}` structures sent through `ConvertTo-Json -Compress`, instead of base64. Bodies PowerShell 7 cannot reproduce exactly stay as exact text; binary bodies keep base64. The snippet now stops with an error in Windows PowerShell 5.1 instead of only noting the requirement in a comment.
- [Copy as][copy-as] cURL (bash) sends text bodies inline as one readable `--data-raw` word (ANSI-C `$'...'` quoting only when the body has control characters) instead of a `printf` hex pipe, which remains for binary and very large bodies. Redundant `--request` and quoted option names are gone, and a capture without a Content-Type no longer gets curl's form-urlencoded default.
- [Copy as][copy-as] Python replaces the separate Python requests and Python httpx entries; choose the package in **Settings > Network > [Python library][python-library]** (requests by default). A saved preference for one of the old entries carries over.
- The location filter is replaced by the [source filter][source-filter], which applies to Authored and Deployed files and their exports, including Export All. The Network list keeps its own filters.
- The status bar keeps showing the capture counts while background scans run instead of switching to "Scanning sources...". Errors and finished exports show for a few seconds, errors in red.
- Requests without a host name, such as `data:` URLs, are listed under "(no domain)" and can be filtered by it.

### Bug Fixes

- The request body language dropdown no longer stays in the editor footer after switching from a request to a file.
- [Smart TypeScript diagnostics][ts-diagnostics] also hide "Untyped function calls may not accept type arguments", which only appears because a package import could not be resolved.
- When response bytes are unavailable, the hex view now points to choosing a text language to read the decoded text.
- [Copy as][copy-as] Python no longer falls back to a raw string for JSON with long floats such as `0.8999999761581421` (a common `devicePixelRatio`); any float Python prints the same way now keeps the readable structure.

### Developer Information

- Keep release notes in a single root `CHANGELOG.md`; `scripts/changelog-notes.js` extracts one version's notes for GitHub releases.
- Add `lib/code-format.js` (formatting style to js-beautify options), `lib/source-filter.js` (rule language and matcher), and `core/source-filter-state.js` (filter state and explorer grouping), with tests in `scripts/test-code-format.js` and `scripts/test-source-filter.js`.
- Add a [Settings reference][settings] and screenshots to the README and guides under `docs/`.

[source-filter]: https://github.com/stugmi/SourceExporter/blob/main/docs/usage.md#filter-and-group-files
[group-files]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#group-files-by
[code-formatting]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#code-formatting
[braces]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#braces-and-objects
[pause-watching]: https://github.com/stugmi/SourceExporter/blob/main/docs/usage.md#pause-watching
[copy-as]: https://github.com/stugmi/SourceExporter/blob/main/docs/network.md#copy-as-code
[embedded-json]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#embedded-json-in-python
[python-library]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#python-library
[network-filters]: https://github.com/stugmi/SourceExporter/blob/main/docs/network.md#filters
[ts-diagnostics]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#typescript-diagnostics-for-authored-files
[line-width]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md#replay-line-width
[settings]: https://github.com/stugmi/SourceExporter/blob/main/docs/settings.md

## 1.4.3

### New Features

- Decode base64 body text into the hex viewer with **Hex (Base64 decoded)**, offered when the whole body is valid base64. Concatenated gRPC-web frames are supported.

### Bug Fixes

- Show gRPC-web text bodies (`application/grpc-web-text`) as text instead of a hex dump of their base64 characters, and copy them as text in Copy as.

## 1.4.2

### New Features

- Inspect binary bodies in an interactive hex viewer: address column, byte grid with ASCII, selection, go to offset, find hex or text, and copy as hex, C array, Python bytes, base64, or ASCII.
- Decode the bytes at the cursor in a data inspector: 8 to 64-bit integers, half/float/double/bfloat16, LEB128, bool, and ASCII/UTF-8/UTF-16 characters, in little or big endian.

### Changes

- Choose Hex from the body language dropdown; Auto selects it for binary bodies. The separate Hex toggle is gone.
- Center jumps to initiator frames, search results, and definitions, and briefly highlight the target line.

### Bug Fixes

- Initiator jumps no longer land at the top edge of the editor, under sticky scroll, after switching workspaces.

## 1.4.1

### New Features

- Copy requests as Python requests/httpx, browser or Node.js fetch, PowerShell, and cURL for bash or cmd.
- Select request ranges or individual rows for batch copying and export.
- Inspect initiator call stacks and async frames, with mapped-source navigation and raw-script fallback.
- Inspect binary payloads and responses in a paged Hex view with offsets and ASCII.

### Changes

- Choose a preferred replay format and line width in Settings. Generated code uses readable multiline values; Python snippets omit imports.
- Keep the README focused on the project overview and feature list, with detailed guides in `docs/`.

### Bug Fixes

- Preserve captured binary request bytes and refuse lossy or unsupported replays instead of silently changing data.
- Detect and format validated JSON record batches while preserving large integers.
- Highlight failed and blocked network requests in red, with their captured error messages.
- Preserve workspace tabs, request selection, and editor positions when following initiator links.
- Handle canceled Monaco occurrence-highlighting work when editor models change.

## 1.3.1

### Hotfixes

- Use Ctrl+Shift+F to search all captured files; reserve Shift+Alt+F for pretty-formatting.

### Developer Information

- Move detailed usage and contributor guides into `docs/` and keep the README focused on the overview and quick start.

## 1.3.0

### New Features

- Open network requests in a new tab or copy their full URL from the context menu.
- Toggle editor settings, including Sticky Scroll, from the command palette.

### Changes

- Reduce repeated request-list rendering and expand JSON response trees on demand.

### Bug Fixes

- Keep Files and Network selections independent, and reveal the selected request after filter or sort changes.
- Show the command palette above Settings instead of behind it.
- Read large inline source maps without corrupting UTF-8 source text.
- Preserve large integer values when formatting JSON responses.
- Export long and Unicode file paths correctly in TAR archives.

### Security

- Isolate response previews in a sandbox and block remote resource loading.

### Developer Information

- Organize JavaScript and CSS by feature and centralize keyboard shortcut definitions.
- Use pinned Bun tooling for dependency installation, linting, formatting, checks, and builds.
- Publish shared Markdown changelogs on versioned and rolling releases, with fresh publication dates for rolling builds.
