# Tooling for the workflows

`workflows.md` says what happens and names no tool. This doc says which
tool plays each role, why, and what that means for this repo. Decisions
as of 2026-09-20, for ENG-21. Where a pick is made, the reasoning sits
next to it so a later me can overturn it.

## Role to tool

| Role in the workflow | Tool | Why this one |
| --- | --- | --- |
| Tracker | Linear | Already where I plan. Has the kanban states the workflow needs, labels, and closes a ticket on its own when a linked PR merges |
| Session client | Orca, `serve` mode on the home server, over Tailscale | Phone and desktop apps, sessions in their own worktree or container, a Linear sidebar, reopen any finished session. Survey below |
| Agent in a session | Claude Code on the subscription token | What the skills are written for. Orca can swap it per session later |
| Daemon | border-collie, cut down | It already has the selection, claim and settle logic. It loses everything Orca now does. Section below |
| Review agent | CodeRabbit | Hosted, no skill to write, verdict on every PR. Not building my own |
| PR checks, staging deploy, release | The repo's own CI | Not an agent job |
| Observability and the bug it raises | Undecided | Open in `workflows.md` |
| Skills | Vendored into each repo under `.claude/skills` | A session in a worktree of the repo loads them with no setup. `skills.md` |

Two things the roles table settles that the old design left open. The
tracker is Linear, not GitHub Issues, because the workflow's claim is a
status change and its labels are Linear labels. And the daemon starts
sessions through Orca's CLI rather than its own containers, because Orca
owns isolation, persistence and the transcript viewer, and a session it
started is one I can open from my phone.

## What this means for border-collie

The daemon shrinks to the loop nothing on the market ships: watch the
tracker, claim by status, start a session, handle the session ending
badly. Everything else it does today is now Orca's or CodeRabbit's.

| Today | After | Reason |
| --- | --- | --- |
| Reads GitHub Issues, claims by label plus marker comment | Reads Linear, claims by moving the ticket to in progress | The board is the claim, same as when I pick a ticket up by hand |
| Builds a Docker image, launches a container per Attempt, keeps transcripts | Calls `orca worktree create` on the serve environment | Orca owns isolation and the session record |
| Attempts, a retry cap, Escalation | One failure puts the ticket back to todo with the stop label and a comment | I relabel if I want it to go again. Nothing retries on its own |
| Refinement rounds on review or CI | The session runs `address-review` on its own PR | CodeRabbit posts the review. The session acts on it, bounded by the same skill |
| Human merges everything | Merge on CodeRabbit's verdict for what the daemon started and the docs agent; I merge the rest | The verdict is the gate. `workflows.md` "Who merges what" |
| Conflict Worker, mechanical rebase | Open | `workflows.md` last open item |
| Verify contract in `WORKFLOW.md`, run after the session | Keep. `address-review` and `implement` run it inside the session | Still the only machine-readable definition of green |
| Working-hours gate, per-repo fleet policy | Keep | Still about quota, which Orca does not manage |

Three ADRs describe the old shape and are now reference rather than
rule: 0002 (GitHub as the single tracker), 0006 and 0009 (the execution
substrate), and the 2026-08 amendments to 0001 that argued the daemon must
dispatch from the tracker itself. The decision in 0001 that the daemon
stays a deterministic loop with no judgement in it survives untouched.

One design question to settle before the adapter is written. Today a
Worker settles itself after its session ends. Under Orca there is no
"after the session" hook, only `orca terminal wait` reporting the TUI went
idle. The daemon should treat idle plus no PR linked to the ticket as a
failed session, and idle plus a PR as done. Both facts come from the
tracker and the repo, not from the agent's own report.

## Remote access and the home server (ENG-56)

The host exists: the home server is an Intel T2 MacBook on Ubuntu with
tmux, Claude Code, Docker and LAN access set up (ENG-41 to ENG-44,
ENG-29). Orca `serve` runs there, the phone and laptop pair to it over
Tailscale, which is not installed yet.

Two things block this before any tool. The box lost power three times in
one week in September (ENG-72, ENG-73, ENG-74: an unexplained blackout, a
kernel crash on suspend, and a battery routine that ran it flat). A
session host nobody can reach is not remote access. And ENG-55, writing
down what is on the server, is what lets any session there discover its
environment instead of guessing.

## Alternatives on the market

The ticket asks whether something free and open source already does this.
Surveyed 2026-09-19 and 2026-09-20 from primary sources, starting from the
survey on ENG-56 and the curated
[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
list. Short answer: Orca replaces the session side outright, nothing
replaces the daemon, and the daemon is small.

ADR 0001 already did part of this in August (issue #134, the Orca prior-art
notes on the `research/orca-prior-art` branch), and its conclusion holds
after a wider look: dependency gating and always-on execution are no longer
rare. What nobody else ships is the tracker as the only state store plus the
PR lifecycle after the commit.

### Session clients with a phone in the loop

| | Orca | Paseo | T3 Code | kandev | Open Session |
| --- | --- | --- | --- | --- | --- |
| Licence, size | MIT | Apache-2.0, 17.7k stars, v0.8.0 | MIT, alpha nightlies | AGPL-3.0, v0.95 | MIT, v0.4.65 |
| Server on the home box | `orca serve` | npm global or Docker image, port 6767 | Local server, login service on Linux | npm global, Docker doc | Install script with Tailscale or Cloudflare flags |
| Phone | iOS and Android apps, QR pairing | iOS and Android store apps, plus web | iOS and Android apps | Browser only, Tailscale Serve guide | PWA, iOS app you build yourself |
| Transport | Tailscale recommended, nothing proxied | Direct, Tailscale, or an opt-in end-to-end encrypted relay, off by default | LAN, Tailscale, or T3 Connect relay through T3's infra, three devices | Tailscale, Cloudflare Access, VPN | Tailscale, Cloudflare Tunnel |
| Providers | 40 plus | Claude Code, Codex, Copilot, OpenCode, Pi | Claude Code, Codex, Cursor, OpenCode, Pi, Grok | 20 plus over ACP, any CLI via PTY | Pi engine over Claude, OpenAI, xAI account pools |
| Reopen a finished session | Yes, via `claude --resume` and the Codex, Pi, Cursor equivalents, raw log viewable | Yes, "closed is the persisted, resumable state" | Threads persist and resume | Resume while the executor still has the record | Per-session SQLite event logs, reopen UI not stated |
| Linear | Native tasks sidebar, start a worktree from an issue | None built in, client library to build your own | No, open feature request | Pulls issues into the kanban, launch from a card | Linear agent assignment auto-starts a session |
| Unattended | Cron or RRULE automations with a shell precheck | Cron schedules | Scheduled prompts | Schedules, webhooks, GitHub PR conditions | Scheduled and event automations, GitHub webhooks, CI autofix |
| Billing | Bring your own subscription | Agent CLI's own credentials, no account | Provider CLI login | Agent CLI login as the same OS user | Subscription logins or API keys |
| Isolation | Worktree, SSH targets, cloud VM or Docker per worktree | Worktree, or the daemon in Docker | Worktree | Worktree, Docker, SSH, Kubernetes | Worktree or Daytona sandboxes |

Set aside with a reason: intentic (MIT, the broadest trigger set, but sign-in
with Google at the vendor's app is mandatory and the platform half is dev-mode
only), Zeron (MIT, native iOS, but multi-device sync goes through the vendor's
relay and a self-hosted backend is "future work"), Garcon (GPL, browser only,
its own security doc says keep it on a trusted network, no sandbox), omg.dev
and Continuum (from the ENG-56 note, not read from their own docs).

herdr (Apache-2.0, 39.7k stars, v0.9.1) is in a different category and
is not a competitor for this pick. It is a terminal multiplexer with a
headless server per machine that owns the agents' terminals, tracks each
pane as working, blocked or idle, and exposes a socket API so agents spawn
and prompt each other. Twenty-two agent CLIs, worktrees first-class, runs
the CLIs unchanged so subscription login applies. What it lacks for this
workflow: no phone app or browser UI (remote reach is an SSH client on the
phone over Tailscale), no Linear or GitHub Issues intake, no cron or
webhooks, no containers, and no viewer for finished sessions. What it has
that Orca does not: agent-to-agent spawn, prompt and wait as an API,
several machines aggregated in one client, and a plugin marketplace. If the
daemon side ever needs to drive agents on more than one host from one
socket, herdr is the piece to look at. For the planning session from a
phone, it is not.

**Pick: Orca, `serve` mode, on the home server, over Tailscale.** It answers
three of the board's open questions on its own. "Can we open back the chat"
is its session history panel, done with the same `claude --resume` I would
script by hand. "Pluggable providers" is its premise, so every session I
start gets provider choice for free while the daemon's sessions stay
Claude-only until the skills say otherwise. "Kanban" is its Linear
sidebar: a worktree starts from a Linear issue.

Paseo is the runner-up and a real one: bigger community, Apache licence, no
account, store apps on both platforms. It loses on Linear, which it leaves to
you to build. If Orca's mobile app disappoints, Paseo is the fallback and the
switch costs an afternoon. T3 Code loses on no Linear and a relay through
someone else's infra. kandev has the widest matrix but AGPL and browser only.

### Task runners that overlap border-collie

Nine checked against what border-collie does after a ticket is claimed:
Contrabass, lalph, cyrus, no_human, NEEDLE, Machinist, gastown, Taskuary,
aeon, plus Open Session's intake side from the table above. Not one
documents rebasing sibling PRs after a merge, a dedicated conflict session,
or retry up to a cap then escalate. The ones that come closest:

- **Contrabass** (Apache-2.0) gates on `BlockedBy`, claims per issue, one
  worktree per issue, backoff retries. No PR lifecycle at all, and no Claude
  Code runner. Last commit July.
- **lalph** (MIT) reads GitHub Issues and Linear with `blockedBy`, worktrees,
  optional PR flow with auto-merge. No failure handling, no daemon.
- **cyrus** (Apache-2.0) is the closest in shape: watches issues assigned to
  it on Linear or GitHub, worktree per issue, systemd daemon, and takes a
  `CLAUDE_CODE_OAUTH_TOKEN`. No dependency gating, no retry or escalation,
  nothing after the PR opens.
- **no_human** (MIT) has tracker intake, a second-model reviewer session
  that is told to refute "done", a tamper guard against test deletion, and
  never merges. But it scopes each task with you before it starts, so it is
  a tool for work I am present for, not for the daemon.
- **Open Session** (MIT) auto-starts from a Linear assignment, takes GitHub
  webhooks, and hands CI failures to an autofix session. Its state lives in
  its own SQLite, which is the design ADR 0001 rejects.
- **gastown** (MIT, 18k stars) has the escalation chain and a Bors-style
  merge queue, but on its own git-backed tracker, with a hierarchy of agents
  where border-collie has one deterministic loop.

So the daemon stays a build, and a much smaller one than before. Two
things are worth stealing. no_human's reviewer that must refute "done" is
a good brief for what to ask CodeRabbit to be strict about. Contrabass and
lalph both confirm that reading the tracker's own blocking edges is the
right way to gate, which the daemon keeps doing against Linear's.

## Next steps, in order

1. Fix the server's power and suspend problems (ENG-72, ENG-73, ENG-74).
2. Tailscale on the server and the phone.
3. Orca `serve` on the server, paired from the phone, Linear connected.
   Closes ENG-56.
4. Write the server docs (ENG-55).
5. CodeRabbit on the repos that matter.
6. Write the `triage` skill. It decides the fix session's input shape.
7. Rewrite border-collie's tracker adapter for Linear and its worker
   adapter for Orca's CLI, and delete the container path. Pin the Orca
   version the adapter targets, since its CLI is still moving.
8. The remaining skills from `skills.md`, in the order the workflows need
   them: `address-review`, `sync-docs`, `refactor-pass`, `smoke-test` once
   staging exists.

## Open, tooling only

The workflow's open questions are in `workflows.md`. These are about the
tools:

- How the daemon learns of a Linear label or status change. Webhook needs
  a public endpoint on the home server; polling needs none and Linear's
  API is cheap to poll. Leaning to polling.
- Whether `to-tickets` can be pointed at Linear as it is, or needs a fork.
- Which Orca isolation the daemon asks for per session: worktree only, or
  the per-worktree container environment.
