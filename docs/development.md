# Development

Build and check the extension with the Bun toolchain pinned in the repository.

## Install and build

```sh
bun install --frozen-lockfile
bun run build
```

Load the generated `dist/` folder through **Load unpacked** in `chrome://extensions` with **Developer mode** enabled. Rebuild after source changes and reload the extension to use the new output.

The build creates a clean unpacked extension, copies local Monaco runtime assets, and synchronizes the version from `package.json` into the manifests and panel header. Do not edit generated versions by hand.

## Live panel preview

```sh
bun run dev
```

Open `http://127.0.0.1:5173/` for the standalone panel. Use `bun run dev --port 5174` to choose another port. Stop the server with Ctrl+C.

The server builds once for the local vendor assets, then serves panel HTML, JavaScript, CSS, and images directly from `src/`. Saving a source file, `package.json`, or the demo configuration automatically reloads the page. This is a full-page reload, not state-preserving module replacement: open tabs and unsaved edits reset, while settings stay in this browser origin's local storage.

The preview runs the real panel, Monaco editor, and settings UI against a simulated shop capture. Edit [`scripts/dev-data.js`](../scripts/dev-data.js) to change the default source files, source map, HAR requests, and response bodies. This data is local; no live website, inspected Chrome tab, or MCP connection is needed. To verify real capture behavior, use the [unpacked extension](#install-and-build).

The server listens only on `127.0.0.1`; `--port 0` chooses a free port. Restart it after dependency or dev-server changes to rebuild vendor assets. The demo adapter and reload client are injected only by this server, never into the built extension.

## Documentation screenshots

```sh
bun run screenshots
```

This builds the assets, starts a temporary dev panel on a free port, and refreshes all eight PNGs in [`docs/images/`](images/) using the same [simulated capture](#live-panel-preview). The first run downloads a pinned Playwright headless renderer if needed. It does not open your Chrome profile, inspect a live tab, or request the sample URLs. The temporary server and browser close on success or failure.

Scenes in [`scripts/screenshot-views.js`](../scripts/screenshot-views.js) exercise the current UI for the default editor, Navy theme, search, source filter, formatting settings, JSON response, binary hex view, and Copy as menu. Each run starts with isolated settings, fixed demo timestamps, a 1600 by 950 viewport at 2x scale, and the default dark theme except for the Navy shot. Images are replaced only after all scenes succeed; review the generated images before committing them.

On Linux, install Chromium's system libraries with `bun run --bun playwright install-deps chromium` if Playwright reports missing libraries. Browser assets and temporary output are not committed.

## Checks

| Command                | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `bun run lint`         | Native Bun lint                                 |
| `bun run lint:fix`     | Lint autofixes                                  |
| `bun run format`       | Format source, configuration, and documentation |
| `bun run format:check` | Check formatting without writing                |
| `bun run test`         | Run the existing tests                          |
| `bun run check`        | Run TypeScript, lint, formatting, and build     |

Python replay integration tests execute generated snippets against a local server using real `requests` and `httpx` clients. They skip with a reason when a Python interpreter or the relevant library is unavailable. Set `PYTHON_REQUEST_CODE_PYTHON` to select an interpreter. Native cURL (cmd) coverage runs on Windows; cURL (bash) coverage runs when `bash` and `curl` are available (Git Bash on Windows) and skips otherwise.

## Toolchain configuration

`package.json` and `bun.lock` pin `bun@1.4.4-canary.20261105.1`. Scripts resolve the local binary; no global canary upgrade is needed. Bun 1.4.4 stable has the formatter but not native lint, so CI uses stable Bun to bootstrap installation and the pinned canary for checks.

- [`bunfig.toml`](../bunfig.toml) configures [Bun formatting](https://bun.com/docs/format).
- [`eslint.config.js`](../eslint.config.js) supplies supported rule settings and shared-global declarations for [Bun lint](https://bun.com/docs/lint).
- `@eslint/js` and `globals` supply configuration data, not the ESLint engine. ESLint, Prettier, and their plugins are not installed. TypeScript remains the type checker.
- `patches/monaco-editor@0.52.2.patch` fixes cancellation handling in Monaco's occurrence highlighter. Bun applies it during installation.

No VS Code lint or formatter extension is required. Use the commands above for the same checks as CI.

See [architecture](architecture.md) for the source layout.
