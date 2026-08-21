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
