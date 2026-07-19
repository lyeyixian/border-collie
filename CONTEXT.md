# border-collie

An orchestration loop that implements a set of tracer-bullet tickets with a fleet of Claude Code agents, respecting blocking dependencies, until every ticket is merged and closed.

## Language

**Orchestrator**:
The deterministic program that runs the dispatch loop — it holds no intelligence, only mechanical control flow (query, claim, spawn, poll). All judgment lives in Workers.
_Avoid_: dispatcher agent, coordinator agent

**Ticket**:
An open issue on the tracker produced by `/to-tickets`: a tracer-bullet vertical slice sized to one fresh agent context window, carrying native blocking edges and the `ready-for-agent` label.
_Avoid_: task, story

**Dispatchable**:
A ticket that is open, unassigned, labelled `ready-for-agent`, and whose blockers are all closed — eligible for dispatch (the concurrency caps decide how many actually go each Tick). The dispatchable set is the only place the Orchestrator takes work from.
_Avoid_: frontier (the upstream mattpocock-skills docs use "frontier" for this same set), ready, grabbable

**Claim**:
Assigning a ticket to the working identity *before* any work begins, plus a marker comment identifying the claim as border-collie's. An assignee without the marker comment is a human claim — hands off. Releasing a claim appends a release marker comment (never deletes); the latest marker comment decides whether an assignment is agent-held.
_Avoid_: lock, lease

**Worker**:
A fresh-context Claude Code agent session dispatched against exactly one Ticket, isolated in its own git worktree and branch. Fed nothing beyond its ticket plus repo context it discovers itself.
_Avoid_: agent (unqualified), subagent

**Done**:
A ticket is done when its PR is merged and the ticket is closed — not when the worker commits.

**Tick**:
One idempotent pass of the loop: recompute the world from GitHub, take every action now due. A run is a sequence of ticks; any single tick is a complete unit.

**Scope**:
The ticket set a run is responsible for — by default the sub-issues of one parent issue, not every agent-ready issue in the repo.

**Attempt**:
One Worker session against one ticket. A ticket gets at most two before Escalation.

**Ticket failure**:
An attempt that failed because of the ticket or the work — crash, no commits, stall, timeout, blown budget. Counts against the ticket's attempts.

**Infrastructure failure**:
A failure caused by the environment — usage limit, rate limit, auth, network. Counts as nothing; voids the attempt and trips the circuit breaker (pause dispatch, resume when the environment recovers).

**Escalation**:
Handing a ticket to a human after its attempts are exhausted: swap `ready-for-agent` → `ready-for-human`, unassign, leave a forensic comment. An escalated ticket stops being Dispatchable by construction; its dependents stay blocked.

**Complete**:
Terminal state of a run: every ticket in Scope merged and closed.

**Stuck**:
Terminal state of a run: open tickets remain in Scope, but every path forward runs through a human. The run exits with a report of what is stuck on what.
_Avoid_: blocked (that's a ticket-level state, not a run-level one)
