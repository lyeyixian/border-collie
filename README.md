# border-collie

An orchestration loop that implements a set of tracer-bullet tickets with a fleet of Claude Code agents — respecting blocking dependencies, dispatching one fresh-context worker per ticket, until every ticket is merged and closed.

Like its namesake, it herds: the orchestrator watches for dispatchable tickets (open, unclaimed, all blockers closed), claims them by assignment, spawns isolated workers in git worktrees, and rounds up their pull requests for a human to merge.

## The loop

```
while open tickets remain:
  dispatchable = open ∧ unassigned ∧ ready-for-agent ∧ all blockers closed
  for each dispatchable ticket (up to concurrency cap):
    claim (assign) → spawn isolated worker (fresh context, own git worktree/branch)
    worker: implement the ticket → push branch → open draft PR linking the ticket
  wait for PRs to merge; on merge → close ticket → recompute the dispatchable set
```

## Status

Design phase. See [docs/handoff-ticket-fleet-orchestrator.md](docs/handoff-ticket-fleet-orchestrator.md) for the design context this project started from, including the decisions already taken and the open questions still to settle.
