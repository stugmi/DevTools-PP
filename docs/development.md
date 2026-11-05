# Development

Build and check the extension with the Bun toolchain pinned in the repository.

## Install and build

```sh
bun install --frozen-lockfile
bun run build
```

Load the generated `dist/` folder through **Load unpacked** in `chrome://extensions` with **Developer mode** enabled. Rebuild after source changes and reload the extension to use the new output.

The build creates a clean unpacked extension, copies local Monaco runtime assets, and synchronizes the version from `package.json` into the manifests and panel header. Do not edit generated versions by hand.

## Checks

| Command                | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `bun run lint`         | Native Bun lint                                 |
| `bun run lint:fix`     | Lint autofixes                                  |
| `bun run format`       | Format source, configuration, and documentation |
| `bun run format:check` | Check formatting without writing                |
| `bun run test`         | Run the existing tests                          |
| `bun run check`        | Run TypeScript, lint, formatting, and build     |

## Toolchain configuration

`package.json` and `bun.lock` pin `bun@1.4.4-canary.20261105.1`. Scripts resolve the local binary; no global canary upgrade is needed. Bun 1.4.4 stable has the formatter but not native lint, so CI uses stable Bun to bootstrap installation and the pinned canary for checks.

- [`bunfig.toml`](../bunfig.toml) configures [Bun formatting](https://bun.com/docs/format).
- [`eslint.config.js`](../eslint.config.js) supplies supported rule settings and shared-global declarations for [Bun lint](https://bun.com/docs/lint).
- `@eslint/js` and `globals` supply configuration data, not the ESLint engine. ESLint, Prettier, and their plugins are not installed. TypeScript remains the type checker.

No VS Code lint or formatter extension is required. Use the commands above for the same checks as CI.

See [architecture](architecture.md) for the source layout and [releases](releases.md) before changing the version.
