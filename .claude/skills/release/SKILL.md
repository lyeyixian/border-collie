---
name: release
description: Cut a release — bump, tag, watch the publish land, then point the fleet at it.
disable-model-invocation: true
---

# Release

Releases are tag-driven. Pushing a `v*` tag runs `.github/workflows/release.yml`: the CI gates, a guard that the tag matches `package.json`, an npm publish over OIDC trusted publishing, and a GitHub Release with generated notes. Your job is the bump, the tag, and the aftercare — the workflow does the rest.

Rationale for the ordering below lives in README "Release process"; read it if a step looks reorderable.

## 1. Preflight

```
git switch main && git pull --ff-only
git status --porcelain          # must be empty
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run smoke
```

Release from `main` only. The five gates are the same ones the release workflow runs — failing them here costs a rerun, failing them there leaves a pushed tag with no publish and a recovery (below).

Then pick the bump from the Conventional Commit types since the last tag:

```
git log "$(git describe --tags --abbrev=0)"..main --oneline
```

Breaking change → `major`; any `feat` → `minor`; otherwise `patch`. Report the chosen bump and the commits behind it before cutting. Done when every commit in that range has been accounted for in the decision.

## 2. Cut and push

```
npm version <patch|minor|major> -m "chore(release): %s"
git push --follow-tags
```

`npm version` writes the `chore(release): X.Y.Z` commit and the annotated `vX.Y.Z` tag.

## 3. Watch the publish land

```
gh run list --workflow=release.yml --limit 1
gh run watch <run-id> --exit-status
npm view border-collie version          # must equal the new version
gh release view "v<version>"
```

Step 4 starts only once npm reports the new version.

## 4. Point the fleet at it

```
pnpm run sync:version
git commit -am "chore(release): point the fleet at <version>"
git push
```

`sync:version` rewrites the `npm install -g border-collie@<version>` pin in the two scaffolded workflows, which is what this repo's own fleet installs every Tick. Ahead of the publish that pin 404s every Tick in the window — including the half-hourly cron backstop — so it moves after step 3, never folded into step 2. Behind `package.json` it is harmless: the fleet keeps running the last version that exists. A test enforces that one-sidedness.

This moves *this* repository's fleet only. A repo scaffolded by `border-collie init` gets pinned to the CLI version that scaffolded it, resolved at scaffold time.

## Rehearsal

```
gh workflow run release.yml
```

`workflow_dispatch` runs the same gates and `pnpm publish --dry-run` — no tag, no publish, no release.

## Recovery

- **Gates or guard failed, nothing published** — delete the tag locally and on the remote (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix on `main`, re-cut the same version.
- **Publish succeeded, GitHub Release step failed** — the version is on npm and immutable. Leave the tag alone and create the release by hand: `gh release create vX.Y.Z --generate-notes`.
- **Publish succeeded and the build is bad** — release a new patch version. A published version is never re-pointed or unpublished.
