# Changelog

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
