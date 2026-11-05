# Releases and changelogs

Versioned Markdown files are the source of truth for GitHub release notes.

## Write release notes

Keep notes in `changelogs/<version>.md`, matching `package.json`. See [versioned changelogs](../changelogs/) or [1.3.0](../changelogs/1.3.0.md) for an example.

Use compact, outcome-first bullets under populated, version-prefixed headings:

- Hotfixes
- New Features
- Changes
- Bug Fixes
- Security
- Developer Information

Omit empty sections, duplicates, commit dumps, and unfinished work. Update notes alongside shipped changes. After a version is published, new shipped behavior needs a version bump and a new changelog; do not rewrite earlier release history.

Factual corrections belong in the original Markdown and must be synchronized to the affected release, not maintained as separate GitHub prose. Use `gh release edit v<version> --notes-file changelogs/<version>.md` for an older version's corrected notes.

## Publication

Successful builds publish the same Markdown to `v<version>` and rolling `latest` releases. Missing or empty changelogs stop publication.

- Versioned releases keep their original tags and assets. Rebuilding the same version only synchronizes its notes.
- The rolling release is recreated so its publication date matches the build. Its tag and download URLs stay the same; its release ID and reactions reset.

`bun run format:check` includes documentation and changelog files. Build and check commands are in [development](development.md).
