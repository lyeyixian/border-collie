# border-collie

An orchestration loop that implements a set of tracer-bullet tickets with a fleet of Claude Code agents — respecting blocking dependencies, dispatching one fresh-context worker per ticket, until every ticket is merged and closed.

Like its namesake, it herds: the orchestrator watches for dispatchable tickets (open, unclaimed, all blockers closed), claims them by label, spawns isolated workers in git worktrees, and rounds up their pull requests for a human to merge.

## The loop

```
while open tickets remain:
  dispatchable = open ∧ unassigned ∧ unclaimed ∧ ready-for-agent ∧ all blockers closed
  for each dispatchable ticket (up to concurrency cap):
    claim (label) → spawn isolated worker (fresh context, own git worktree/branch)
    worker: implement the ticket → push branch → open draft PR linking the ticket
  wait for PRs to merge; on merge → close ticket → recompute the dispatchable set
```

## Install

Requires Node >=24.

```
npx border-collie <tick|run>
```

or install it globally:

```
npm install -g border-collie
```

## Release process

Releases are tag-driven (see `.github/workflows/release.yml`):

1. Bump the version and tag it: `npm version <patch|minor|major>`.
2. Push the tag: `git push --follow-tags`.
3. Pushing a `v*` tag runs the release workflow: the same lint/typecheck/test/build/smoke gates as CI, a guard that the tag matches `package.json`'s version, a publish to npm over OIDC trusted publishing (no npm token stored in the repo), and a GitHub Release with generated notes.

To rehearse a release without publishing, run the release workflow manually from the Actions tab (`workflow_dispatch`) — it runs the same gates and a `pnpm publish --dry-run` instead of a real publish.

### One-time bootstrap

Trusted publishing has to be bound to an npm package that already exists, so the very first release can't go through the workflow:

1. Publish the first version manually from a local machine: `pnpm publish`.
2. On npmjs.com, open the package's settings and add a trusted publisher: GitHub Actions, this repo, and the release workflow's filename (`release.yml`).
3. Renaming the release workflow file afterwards breaks this binding — npm matches on the exact filename. Re-register the trusted publisher with the new filename if you rename it.

## Continuous operation

This repository dogfoods itself: `.github/workflows/border-collie-tick.yml` runs `tick` against its own Scope (`border-collie.json`) as a GitHub Actions job, so it makes progress with no laptop open. A Tick fires on pull request closure, on the Worker job completing, on manual dispatch, and on a half-hourly cron backstop; a concurrency group serialises Ticks, and every Tick recomputes the world from GitHub, so a dropped duplicate loses nothing.

Writes that must retrigger a workflow — dispatching a Worker's job, and a branch this Tick pushes back to an open PR — authenticate with a GitHub App installation token rather than the default `GITHUB_TOKEN`, which GitHub's own recursive-trigger guard silently ignores for exactly those writes. Running the workflow requires:

- `BORDER_COLLIE_APP_ID` and `BORDER_COLLIE_APP_PRIVATE_KEY`: a GitHub App installed on this repository with contents, issues, and pull request write access, and workflow-run read access (deliberately excluding workflow write, so a Worker can never rewrite the workflow that runs it).
- `CLAUDE_CODE_OAUTH_TOKEN`: a subscription OAuth token (`claude setup-token`) for the headless sessions the Tick still runs inline — Conflict Workers and Refinement rounds.

## Status

Design phase. See [docs/handoff-ticket-fleet-orchestrator.md](docs/handoff-ticket-fleet-orchestrator.md) for the design context this project started from, including the decisions already taken and the open questions still to settle.
