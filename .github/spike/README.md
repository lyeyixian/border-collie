# Spike: OAuth token longevity in CI (issue #63)

**This directory is a throwaway experiment, not part of the product.** Nothing
here is imported by `src/`, exercised by the test suite, or reachable from the
shipped `dist/`. It exists to answer one question before the cloud migration is
built on top of the answer.

One thread does run in normal CI: `tsconfig.json` now includes `scripts/`, so
`pnpm typecheck` covers `spike-observe.ts` and `spike-decide.ts`. That is
deliberate — they import `src/core/classify.ts`, and an unchecked script would
let that reuse rot silently — but it is also the one line to undo at disposal.

## The question

border-collie's Workers are long-lived — `DEFAULT_TIMEOUT_MINUTES` is 45 and
`--max-turns` is 200 — so a Worker implementing one tracer-bullet Ticket runs
15–40 minutes inside a single headless `claude -p` invocation. Moving the fleet
off the operator's laptop means authenticating headless Claude Code in CI, which
under subscription billing means `CLAUDE_CODE_OAUTH_TOKEN`. There are reports
([anthropics/claude-code#28827](https://github.com/anthropics/claude-code/issues/28827))
that OAuth access tokens are not refreshed in non-interactive runs, producing
`401 authentication_error` after roughly 10–15 minutes.

If that is still true, every Worker dies mid-Attempt, every death classifies as
an Infrastructure failure, the circuit breaker trips every Tick, and no Ticket
ever reaches Done. The GitHub Actions substrate would be unusable — and nobody
here has measured it.

## What is here

| File | Role |
| --- | --- |
| `../workflows/spike-oauth-longevity.yml` | The experiment. Two measuring jobs plus a decision job, one manual trigger. |
| `oauth-longevity-prompt.md` | The prompt both jobs run, byte-identical. |
| `../../scripts/spike-observe.ts` | Reduces one job's captured evidence to a recorded observation. |
| `../../scripts/spike-decide.ts` | Applies the decision rule to both observations and writes the finding. |

The two measuring jobs share a token, a prompt, a turn cap, a model, and a point
in time. The runner is the only thing chosen differently:

- **Job A** — raw `claude -p`, argv mirroring `claudeArgs()` in
  `src/adapters/worker.ts`, stdout to a transcript and stderr to its own file,
  exactly as `realSpawnWorkerProcess` splits them.
- **Job B** — `anthropics/claude-code-action@v1`, the Anthropic-maintained CI
  wrapper, with the same prompt and turn cap through its `claude_args`
  passthrough.

Everything else that differs between them is imposed by the runner rather than
chosen, and each difference is itself an observation: Job B needs a
`github_token`, owns its own permissioning (so no
`--dangerously-skip-permissions`), installs its own Claude Code, takes its
wall-clock ceiling from a step timeout rather than `timeout(1)`, and gives back
no separate stderr stream at all.

The prompt is a four-pass read-only analysis of `src/` and `tests/` — around
forty files and ten thousand lines. It is chosen to generate continuous tool
activity well past the 10–15 minute danger zone without editing a file, making
a network call, running a writing `git` command, or touching the tracker, all
of which it forbids explicitly.

It also forbids batching: one tool call per step, one file at a time. The first
run of this spike covered all thirty-nine files in forty-three turns and
finished in nine minutes, answering nothing — the session was never the
constraint, the work was. Serialising the reads and adding the cross-reference
pass is what makes the run long enough to be worth measuring.

`spike-observe.ts` deliberately reuses the Orchestrator's own
`classifyInfrastructure`, `parseResultEvent`, and `lastResultLine` from
`src/core/classify.ts`, against the same two sources a real Worker death is
classified from (stderr and the result line, never the transcript body). If a
death here reports `auth`, the identical evidence would void an Attempt and trip
the circuit breaker in production.

## Running it

One-time setup, by a repository admin:

1. Generate a token locally: `claude setup-token`.
2. Store it as the repository secret `CLAUDE_CODE_OAUTH_TOKEN`
   (`gh secret set CLAUDE_CODE_OAUTH_TOKEN`). Never commit it, and never pass
   it on a command line — the jobs upload files they write themselves, and
   GitHub masks secrets in the workflow log only.

Then:

```sh
gh workflow run "Spike — OAuth token longevity (#63)"
gh run watch
```

Inputs default to the production values (`sonnet`, 200 turns, a 45-minute
ceiling) and only need overriding to re-test a narrower window. This repository
is public, so the runner minutes are free.

Each measuring job writes a job summary table and uploads a `spike-evidence/`
artifact; the `decide` job uploads `finding.md`:

- Job A — `transcript.jsonl`, `stderr.log`, `environment.txt`, `observation.json`
- Job B — `execution-file.json`, `action-outputs.txt`, `runner-temp-listing.txt`,
  `environment.txt`, `observation.json`
- decide — `finding.md`

Artifacts are the durable record. The runner filesystem is not, and a claim in
the finding that no artifact backs is not a finding.

One gap the artifacts cannot close on their own: **Job B has no stderr.** The
action exposes no error stream, and if it dies before writing its execution
file there is nothing left to classify — the observation will read
`died-unclassified` whatever actually killed it. That cause is only legible in
the action's own step log, so save it alongside the finding:

```sh
gh run view <run-id> --log-failed > job-b.log
```

Reading a log rather than a captured stream is exactly the observability cost
the spike is measuring, so record that you had to.

## Reading the result

`observation.json` reports a `verdict` and, separately, `tokenSurvival` —
whether the session got past 20 minutes without an `auth` signature. The two are
distinct on purpose: a run killed by the 45-minute wall clock still answers the
question, because the token lasted the whole time. `elapsedSeconds` next to
`hitCeiling` is what separates a token expiry at ~12 minutes from a clean
timeout at 45.

`tokenSurvival` is three-valued, and `inconclusive` is not a failure. A session
that simply finished its four passes in fifteen minutes never tested the token;
lengthen the prompt or raise the turn cap and run it again rather than reading
it as a dead substrate. `model` and `maxTurns` are recorded next to the verdict
for the same reason — a pass measured under weakened dispatch inputs does not
license a real Worker's 45 minutes.

## The decision this gates

The `decide` job applies this rule to both observations and writes `finding.md`
— the table below is what it encodes, kept here so a reader need not run it.

| Outcome | What it means |
| --- | --- |
| Both jobs survive | Build Workers on raw `claude -p`; the classification pipeline, the fleet heartbeat, and the stall watchdog all keep the process seam they ride on. |
| Only Job B survives | Build on the action, and open a follow-up for how much of classification, heartbeat, and stall detection is recoverable without per-chunk stdout and a process death mode. |
| Neither survives | The Actions substrate is invalid for Workers. The substrate decision reopens before anything is built on it. |

Raw `claude -p` is the preferred answer independently of which is nicer: the
last several releases' worth of work — structured log events, per-Worker
correlation, the durable run log, the fleet heartbeat — all ride on owning the
process seam directly. Read the spike as answering "can we keep `claude -p`?"

## Disposal

Post `finding.md` as a comment on issue #63, adding anything only the step logs
could tell you (Job B's cause of death, the Claude Code version the action
installed). If the result changes the substrate decision, record that as an ADR
too, since it would supersede reasoning already captured in `docs/adr/`.

Then, in one commit:

1. Delete this directory, `../workflows/spike-oauth-longevity.yml`,
   `../../scripts/spike-observe.ts`, and `../../scripts/spike-decide.ts` — or
   relabel all four as an explicit periodic canary. Do not leave them in place
   unmarked.
2. Revert `scripts` from `include` in `tsconfig.json` if nothing else has moved
   into `scripts/` as TypeScript by then.
