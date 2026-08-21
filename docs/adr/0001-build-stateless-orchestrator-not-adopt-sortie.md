# Build a stateless orchestrator ourselves instead of adopting sortie

We evaluated adopting [sortie](https://github.com/sortie-ai/sortie) (and studied [OpenAI Symphony](https://github.com/openai/symphony)) rather than building border-collie. Both are actively maintained orchestrators with the same outer shape — poll a tracker by label, spawn one isolated agent workspace per issue, bounded concurrency, stall/retry handling. We decided to build our own because **neither gates dispatch on blocking dependencies**: sortie has no dependency support (none documented, none requested in its tracker), and Symphony's spec explicitly says blockers "do not gate orchestration dispatch." Dispatchability — dispatching only tickets whose blockers are all closed, recomputed after every merge — is border-collie's reason to exist, and a sidecar bolting it onto sortie would be most of border-collie anyway, running as a second poll loop needing reconciliation with the first.

The build is affordable because the Orchestrator is **stateless: GitHub is the only state store**. Claims are a tracker label plus a marker comment, progress is PRs, completion is merges; every tick recomputes the dispatchable set from `gh`, so crash/restart recovery falls out for free and there is no database to reconcile. (Symphony independently validates this shape — its persistence is "intentionally minimal and in-memory," with tracker-driven recovery.) The Orchestrator is a deterministic program, not a Claude session: the loop's control flow is mechanical, and all judgment lives in the Workers.

## Considered Options

- **Adopt sortie as-is** — rejected: with no dispatchability gate, `/to-tickets` output (every ticket labelled `ready-for-agent` at creation) would dispatch the whole DAG at once; workers would implement tickets against unmerged foundations.
- **sortie + dispatchability-gate sidecar** — rejected: the sidecar is the novel 40% of the work, plus operating a second reconciling poll loop.
- **Contribute DAG dispatch upstream** — not pursued for v1: Go codebase, tracker-agnostic abstraction (blocking semantics differ across GitHub/Jira/Linear/Gitea), maintainer roadmap pointed elsewhere.

Both references remain useful as design cribs: Symphony's repo-owned workflow contract, explicit `dispatchable` flag, stall-timeout + exponential-backoff retry semantics, and workspace-path containment are patterns worth borrowing.

## Amendment (2026-08-15) — the rationale moves, the decision stands

Decided on [Does dependency-DAG gating stay core in v2?](https://github.com/lyeyixian/border-collie/issues/128), a ticket of the v2 autonomy roadmap.

"Dispatchability is border-collie's reason to exist" no longer holds. Symphony's spec leaves blocker gating to the adapter, but its announcement describes gating in practice — the moat was always thinner than this ADR claimed. And border-collie never computed a DAG anyway: `isDispatchable` reads one field from GitHub's own `issue_dependencies_summary`, so the gate is a tracker-expressed fact the Orchestrator honours, not a capability it owns. A differentiator that costs one field-read was never going to carry a whole tool.

What v2 rests on instead: always-on autonomy governed entirely through the tracker — the issue tracker as sole state store, the operator reached only when a decision genuinely needs them. Dependency gating stays an unconditional invariant of the dispatch loop (no per-repo opt-out; the tracker port must expose an open-blocker count, and an adapter that cannot express blocking is not a valid adapter) — one rule of the loop, not the reason the loop exists.

The decision to build rather than adopt survives regardless, and is no longer a live comparison: border-collie has diverged far enough — Attempts and the retry ladder, Refinement rounds, serialised conflict resolution (ADR 0007), Escalation, the working-hours gate — that adopting sortie today would be a rewrite, not an adoption.

## Amendment (2026-08-22) — the moat narrows again, and Orca gets named

Decided on [Orca as prior art: what does it already do that v2 plans to build?](https://github.com/lyeyixian/border-collie/issues/134), a research ticket of the same roadmap.

[Orca](https://github.com/stablyai/orca) (MIT, ~49.6k stars, first commit 2026-03-17) did not exist when this ADR was written, and was not in view when the 2026-08-15 amendment moved the moat. Two of its facts land directly here.

**"Neither gates dispatch on blocking dependencies" is now false of the field.** Orca gates dispatch mechanically: only `ready` tasks dispatch, readiness is derived by the runtime rather than by an agent, and the claim's precondition is part of the write. Had the previous amendment not already moved the moat off gating, this would have removed the ADR's rationale outright.

**"Always-on autonomy" no longer distinguishes anything.** `orca serve` plus scheduled automations ship unattended execution — documented, with a VPS deployment guide and a systemd unit, and a `--precheck` shell gate that decides whether a run spends a session at all. Agents working while the operator sleeps is table stakes now.

What survives, and now carries the claim alone: **the tracker is the control plane, not a side-channel.** Nothing Orca ships puts the tracker in the control path. It reads context from Linear and writes status back, but only after a human has started the session, and its own Runs, Tasks, gates and mail live in a local SQLite database with a `reset` command. Border-collie's constraint is the opposite: the issue tracker is the only state store, and every other surface is a stateless client.

Orca is not a build-versus-adopt candidate either. It never dispatches from a tracker unattended — it had an autonomous coordinator and retired it (`orchestration_migration_required`) — and it has no notion of a repo declaring gate-readable named commands, which is exactly what `WORKFLOW.md`'s `verify:` tier is for.

Consequence for the roadmap: the repo-wide-pickup rung keeps its content and loses its pitch. What distinguishes it after Orca is **selection** — a repo-wide pass that claims, gates on blockers, respects attempt budgets and escalates — not that it runs while you sleep.

Evidence: `docs/research/orca-prior-art.md` on the `research/orca-prior-art` branch.
