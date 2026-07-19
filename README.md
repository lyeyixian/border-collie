# border-collie

An orchestration loop that implements a set of tracer-bullet tickets with a fleet of Claude Code agents — respecting blocking dependencies, dispatching one fresh-context worker per ticket, until every ticket is merged and closed.

Like its namesake, it herds: the orchestrator watches the frontier (open tickets whose blockers are all closed), claims tickets by assignment, spawns isolated workers in git worktrees, and rounds up their pull requests for a human to merge.

## The loop

```
while open tickets remain:
  frontier = open ∧ unassigned ∧ ready-for-agent ∧ all blockers closed
  for each frontier ticket (up to concurrency cap):
    claim (assign) → spawn isolated worker (fresh context, own git worktree/branch)
    worker: implement the ticket → push branch → open draft PR linking the ticket
  wait for PRs to merge; on merge → close ticket → recompute frontier
```

## Status

Design phase. See [docs/handoff-ticket-fleet-orchestrator.md](docs/handoff-ticket-fleet-orchestrator.md) for the design context this project started from, including the decisions already taken and the open questions still to settle.
