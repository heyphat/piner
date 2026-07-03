# Releasing piner

The A-to-Z runbook for cutting a new `@heyphat/piner` release to npm.

## Release model

Releases are **tag-driven and mostly manual**. Pushing a `v*` tag to GitHub is the
single trigger: it runs `.github/workflows/release.yml`, which typechecks, tests,
builds, and `npm publish`es. Everything else — version bump, changelog, GitHub
Release entry — is done by hand, in a set order, _before_ the tag is pushed.

Nothing publishes on a normal push or PR merge. Only a `v*` tag publishes.

```
land changes (PR → main)
        │
        ▼
bump version + changelog  ──▶  commit  ──▶  merge to main
        │
        ▼
tag vX.Y.Z on main  ──push──▶  release.yml  ──▶  npm publish
        │
        ▼
gh release create  ──▶  GitHub Releases entry (the repo sidebar)
        │
        ▼
refresh downstreams (pinestack)
```

## Prerequisites (one-time)

- **Bun ≥ 1.2** locally (`engines.node` is `>=18` for consumers; the toolchain is Bun).
- **npm publish rights** to the `@heyphat` scope. CI publishes with an **`NPM_TOKEN`**
  repo secret (an npm _automation_ token) — confirm it exists in
  _Settings → Secrets and variables → Actions_. Provenance is enabled
  (`id-token: write` + `--provenance`), so the token only needs publish scope.
- **`gh` CLI** authenticated (`gh auth status`) for creating the GitHub Release.
- Local npm auth (`.npmrc`) is **only** needed if you ever publish by hand; it is
  gitignored. The normal path publishes from CI, not your machine.

## Versioning policy

Semantic Versioning, and the project is **pre-1.0**, so:

- **Breaking changes → bump MINOR** (`0.3.0 → 0.4.0`). Pre-1.0, minor absorbs breaking.
- **New features / additive API → bump MINOR** (or PATCH if tiny and purely additive).
- **Bug fixes only → bump PATCH** (`0.4.0 → 0.4.1`).

Judge "breaking" from the **consumer's** view of the public API (`src/index.ts` +
`@heyphat/piner/node`). Note a subtlety that has bitten us: adding a **required**
field to an exported interface like `ScriptMetadata` is a type-level break for anyone
who _constructs_ that object, but additive for anyone who only _reads_ what `compile()`
returns — which is everyone in practice. Treat it as additive.

The changelog is written **from the Conventional Commit history** (`feat:`, `fix:`,
`feat(...)!:` for breaking). Keep commits conventional so the log maps cleanly to
changelog sections.

## Step by step

### 0. Start from a green `main`

```bash
git checkout main && git pull
```

CI (`ci.yml`) must be green. Note CI runs typecheck + test + build but **not**
`format:check` — run that yourself (see step 3).

### 1. Land the release's changes

Do the feature/fix work on a branch and merge it via PR as usual. The version bump
and changelog can be part of that same PR or a small dedicated "release prep" PR —
either is fine, as long as they land on `main` _before_ the tag.

### 2. Bump the version

Edit `version` in `package.json` (single source of truth):

```jsonc
"version": "0.4.0",
```

### 3. Update `CHANGELOG.md`

Keep a Changelog format. Add a new `## [X.Y.Z]` section **above** the previous one,
using `### Added` / `### Changed` / `### Changed (breaking)` / `### Fixed` subsections
as needed. Write entries from the consumer's perspective; omit pure dev tooling
(formatting, CI, internal docs, test fixtures).

Then add a compare link at the bottom of the file, above the previous version's link:

```
[0.4.0]: https://github.com/heyphat/piner/compare/v0.3.0...v0.4.0
```

### 4. Verify locally (must all pass)

```bash
bun install
bun run typecheck      # tsc --noEmit
bun test               # full suite incl. the two-backend cross-check
bun run format:check   # prettier --check .
bun run build          # ESM + CJS + .d.ts into dist/
```

The two-backend byte-for-byte cross-check runs inside `bun test`; a green suite is
what guarantees a change didn't diverge the codegen and interpreter backends.

### 5. Commit the release prep and merge to `main`

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): X.Y.Z"
# push the branch and merge its PR into main
```

### 6. Tag on `main` and push

The workflow checks out **the tagged commit**, so tag `main` after the merge — not
your feature branch.

```bash
git checkout main && git pull      # ensure the release-prep commit is present
git tag vX.Y.Z                     # tag name must start with "v"
git push origin vX.Y.Z
```

This is the point of no return: the push triggers `release.yml`.

### 7. Watch the publish

```bash
gh run watch                       # or: gh run list --workflow=release.yml
```

The job runs: checkout → setup Bun → setup Node (npm registry) →
`bun install --frozen-lockfile` → `bun run typecheck` → `bun test` → `bun run build` →
`npm publish --provenance --access public`. Confirm the new version is live:

```bash
npm view @heyphat/piner version
```

### 8. Create the GitHub Release (the sidebar entry)

**`release.yml` does not create a GitHub Release** — it only publishes to npm. The
"Releases" list on the repo page is populated separately. Create it from the tag:

```bash
gh release create vX.Y.Z \
  --title "X.Y.Z — <one-line summary>" \
  --notes "<paste the CHANGELOG section, or use --notes-from-tag>"
```

Until this runs, the repo's Releases sidebar keeps showing the previous version even
though npm already has the new one.

### 9. Refresh downstream consumers

**pinestack** vendors piner as a copied dependency (`file:../piner`), not a live
symlink, so it does not see a new piner until reinstalled:

```bash
cd ../pinestack && bun install --force
bun run typecheck && bun test        # includes its piner version check
```

Any pinestack change that depends on new piner API (e.g. a new `SecurityDependency`
field) must land **after** the piner version it needs is published.

## What `release.yml` does (reference)

`.github/workflows/release.yml`, triggered on `push` of tags matching `v*`:

| Step      | Command                                    |
| --------- | ------------------------------------------ |
| Checkout  | `actions/checkout@v4`                      |
| Bun       | `oven-sh/setup-bun@v2` (latest)            |
| Node      | `actions/setup-node@v4` (20, npm registry) |
| Install   | `bun install --frozen-lockfile`            |
| Typecheck | `bun run typecheck`                        |
| Test      | `bun test`                                 |
| Build     | `bun run build`                            |
| Publish   | `npm publish --provenance --access public` |

Only `dist/` ships (`package.json` `files`), and `prepublishOnly` re-runs `build` as a
safety net. Entry points: `.` (browser/Node ESM + CJS) and `./node` (Node-only
filesystem/async helpers).

## Fixing a botched release

- **Workflow failed before publish** (typecheck/test/build red): the version was never
  published. Delete the tag, fix `main`, re-tag.

  ```bash
  git push --delete origin vX.Y.Z
  git tag -d vX.Y.Z
  # fix, merge, then re-tag from main
  ```

- **Already published to npm, but the build is bad:** do **not** try to reuse the
  version — npm forbids republishing a version, and unpublish is heavily restricted
  (and breaks anyone who already installed it). Ship a **new patch** (`X.Y.Z+1`) with
  the fix. Only `npm deprecate @heyphat/piner@X.Y.Z "reason"` the bad one.

- **Tag pushed to the wrong commit:** delete the remote tag (above) before the
  workflow finishes if you can; otherwise treat it as a bad release and patch forward.

## Quick checklist

```
[ ] main is green (CI passing)
[ ] release changes merged to main
[ ] version bumped in package.json
[ ] CHANGELOG.md section + compare link added
[ ] bun run typecheck / bun test / bun run format:check / bun run build all pass
[ ] chore(release): X.Y.Z committed and merged to main
[ ] git tag vX.Y.Z on main, pushed
[ ] release.yml green; npm view @heyphat/piner version == X.Y.Z
[ ] gh release create vX.Y.Z
[ ] downstream (pinestack) reinstalled if it needs the new version
```
