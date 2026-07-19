# Build a stateless orchestrator ourselves instead of adopting sortie

We evaluated adopting [sortie](https://github.com/sortie-ai/sortie) (and studied [OpenAI Symphony](https://github.com/openai/symphony)) rather than building border-collie. Both are actively maintained orchestrators with the same outer shape — poll a tracker by label, spawn one isolated agent workspace per issue, bounded concurrency, stall/retry handling. We decided to build our own because **neither gates dispatch on blocking dependencies**: sortie has no dependency support (none documented, none requested in its tracker), and Symphony's spec explicitly says blockers "do not gate orchestration dispatch." Dispatchability — dispatching only tickets whose blockers are all closed, recomputed after every merge — is border-collie's reason to exist, and a sidecar bolting it onto sortie would be most of border-collie anyway, running as a second poll loop needing reconciliation with the first.

The build is affordable because the Orchestrator is **stateless: GitHub is the only state store**. Claims are issue assignees, progress is PRs, completion is merges; every tick recomputes the dispatchable set from `gh`, so crash/restart recovery falls out for free and there is no database to reconcile. (Symphony independently validates this shape — its persistence is "intentionally minimal and in-memory," with tracker-driven recovery.) The Orchestrator is a deterministic program, not a Claude session: the loop's control flow is mechanical, and all judgment lives in the Workers.

## Considered Options

- **Adopt sortie as-is** — rejected: with no dispatchability gate, `/to-tickets` output (every ticket labelled `ready-for-agent` at creation) would dispatch the whole DAG at once; workers would implement tickets against unmerged foundations.
- **sortie + dispatchability-gate sidecar** — rejected: the sidecar is the novel 40% of the work, plus operating a second reconciling poll loop.
- **Contribute DAG dispatch upstream** — not pursued for v1: Go codebase, tracker-agnostic abstraction (blocking semantics differ across GitHub/Jira/Linear/Gitea), maintainer roadmap pointed elsewhere.

Both references remain useful as design cribs: Symphony's repo-owned workflow contract, explicit `dispatchable` flag, stall-timeout + exponential-backoff retry semantics, and workspace-path containment are patterns worth borrowing.
