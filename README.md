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

border-collie targets your own repositories and your own Tickets — see [triage labels](docs/agents/triage-labels.md) for what applying `ready-for-agent` asserts about trusting a Ticket's text to an autonomous agent with write access to the repository. Don't point it at a repository that accepts issues or pull requests from strangers.

Requires Node >=24.

```
npx border-collie <tick|run>
```

or install it globally:

```
npm install -g border-collie
```

To run the fleet in GitHub Actions instead of on your own machine, scaffold the workflows into your target repository:

```
npx border-collie init
```

This writes `.github/workflows/border-collie-tick.yml` (the Orchestrator, which also runs Conflict and Refinement Workers inline) and `.github/workflows/border-collie-worker.yml` (one job per dispatched Worker, skills setup included) — never overwriting a file already there unless `--force` is passed — then prints a checklist of the secrets and the minimum GitHub App permissions to supply before the first run (see "Continuous operation" below). Credentials come from a GitHub App you create and install yourself; border-collie hosts no shared service or webhook.

## Release process

Releases are tag-driven (see `.github/workflows/release.yml`):

1. Bump the version and tag it: `npm version <patch|minor|major>`.
2. Push the tag: `git push --follow-tags`.
3. Pushing a `v*` tag runs the release workflow: the same lint/typecheck/test/build/smoke gates as CI, a guard that the tag matches `package.json`'s version, a publish to npm over OIDC trusted publishing (no npm token stored in the repo), and a GitHub Release with generated notes.
4. **Once the publish has landed**, point this repository's own fleet at it: `pnpm run sync:version`, then commit the two workflow files it rewrites.

Step 4 is deliberately after the publish rather than folded into step 1. The workflows `npm install -g border-collie@<version>`, so a pin bumped ahead of the publish would 404 every Tick that fired in the window between — including the half-hourly cron. A pin *behind* `package.json` is harmless, and is the normal state between steps 1 and 4: the fleet simply keeps running the last version that exists. A test enforces that one-sidedness, failing the build only if a pin names a version this package hasn't reached.

To rehearse a release without publishing, run the release workflow manually from the Actions tab (`workflow_dispatch`) — it runs the same gates and a `pnpm publish --dry-run` instead of a real publish.

### One-time bootstrap

Trusted publishing has to be bound to an npm package that already exists, so the very first release can't go through the workflow:

1. Publish the first version manually from a local machine: `pnpm publish`.
2. On npmjs.com, open the package's settings and add a trusted publisher: GitHub Actions, this repo, and the release workflow's filename (`release.yml`).
3. Renaming the release workflow file afterwards breaks this binding — npm matches on the exact filename. Re-register the trusted publisher with the new filename if you rename it.

## Continuous operation

This repository dogfoods itself: `.github/workflows/border-collie-tick.yml` runs `tick` against its own Scope (`border-collie.json`) as a GitHub Actions job, so it makes progress with no laptop open. A Tick fires on pull request closure, on the Worker job completing, on manual dispatch, and on a half-hourly cron backstop; a concurrency group serialises Ticks, and every Tick recomputes the world from GitHub, so a dropped duplicate loses nothing.

Writes that must retrigger a workflow — dispatching a Worker's job, and a branch this Tick pushes back to an open PR — authenticate with a GitHub App installation token rather than the default `GITHUB_TOKEN`, which GitHub's own recursive-trigger guard silently ignores for exactly those writes. Running the workflow requires:

- `BORDER_COLLIE_APP_ID` (repository variable — not sensitive) and `BORDER_COLLIE_APP_PRIVATE_KEY` (repository secret): a GitHub App installed on this repository with contents, issues, and pull request write access, and Actions read/write access to dispatch and read back Worker job runs (deliberately excluding the separate Workflows permission, so a Worker can never rewrite the workflow *file* that runs it).
- `CLAUDE_CODE_OAUTH_TOKEN`: a subscription OAuth token (`claude setup-token`) for the headless sessions the Tick still runs inline — Conflict Workers and Refinement rounds.

Both workflows install the published CLI (`npm install -g border-collie@<version>`) rather than building the repository they check out. The checkout is the repo being *herded*, not the herder: a scaffolded target repo has no build of this package to run, and need not be a Node project at all. One consequence for this repository specifically — it is a consumer of its own package like any other, so a change to fleet behaviour reaches the fleet only once it is released, not when it merges.

The pinned version is deliberate rather than `@latest`: the cron backstop runs unattended, and a floating install would hand a sleeping fleet a breaking release. A repo keeps whatever version scaffolded it until its workflows are re-scaffolded with `border-collie init --force`.

Nothing in the Worker job installs the *target* repo's own dependencies — preparing a toolchain to build and test in is the Worker session's own job, guided by the target repo's `CLAUDE.md`.

`border-collie init` scaffolds both workflow files above into a fresh repository and prints this same checklist.

## Status

Design phase. See [docs/handoff-ticket-fleet-orchestrator.md](docs/handoff-ticket-fleet-orchestrator.md) for the design context this project started from, including the decisions already taken and the open questions still to settle.
