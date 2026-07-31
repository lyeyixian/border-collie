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
A ticket that is open, unassigned, not labelled `claimed`, labelled `ready-for-agent`, whose blockers are all closed, and with no merged agent PR (a merged PR means the work is Done and only closure verification is pending) — eligible for dispatch (the concurrency caps decide how many actually go each Tick). The dispatchable set is the only place the Orchestrator takes work from.
_Avoid_: frontier (the upstream mattpocock-skills docs use "frontier" for this same set), ready, grabbable

**Claim**:
Adding the `claimed` label to a ticket *before* any work begins, plus a marker comment identifying the claim as border-collie's — a label rather than an assignment, because a GitHub App identity cannot be an issue assignee. Assignees are unaffected and mean what they always did: an assignee is a human claim, and border-collie hands off regardless of any marker. Releasing a claim removes the `claimed` label and appends a release marker comment (never deletes); the latest marker comment decides whether the label is agent-held.
_Avoid_: lock, lease, assignment

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
A failure caused by the environment — usage limit, rate limit, auth, network, or several Workers failing the same way within one Tick (correlated). Counts as nothing; voids the attempt (a marker comment uncounts the claim while keeping it held) and trips the circuit breaker (pause dispatch, resume when the environment recovers).

**Working hours**:
The operator's configured off-hours window — a timezone plus start/end hour, resolved fresh each Tick against wall-clock time rather than encoded in a cron expression. While now falls inside it, only the quota-consuming actions (claims, spawns, Conflict Workers) are suppressed; closures, releases, Escalations, mechanical rebases, and the draft-to-ready flip still run every hour, so the world is current when the fleet wakes. Independent of the circuit breaker's pause, which means the environment is broken, not that the operator is awake — either or both may apply at once.
_Avoid_: quiet hours, breaker, dispatch pause (that phrase names the circuit breaker's wider suppression, not this narrower one)

**Escalation**:
Handing a ticket to a human after its attempts are exhausted: swap `ready-for-agent` → `ready-for-human`, leave a forensic comment. Only an already-unclaimed ticket escalates — every failure or orphan release removes the `claimed` label first. An escalated ticket stops being Dispatchable by construction; its dependents stay blocked.

**PR upkeep**:
Keeping the open agent PRs a merge left behind current, each Tick: a cleanly-mergeable PR that fell behind the base gets a mechanical rebase onto the base; a green (or CI-less) draft flips to ready-for-review; a conflicted PR gets a Conflict Worker.
_Avoid_: merge commit (every update is a rebase, keeping agent branches linear so the "Rebase and merge" strategy stays available)

**Conflict Worker**:
The one Worker variant dispatched against a PR rather than a Ticket: a fresh-context session, isolated in a worktree on the conflicted PR's own branch, that completes an in-progress rebase of it onto the base. One per conflict — on failure the PR gets a marker comment asking for a human (the PR-level analogue of Escalation), which vetoes any further session. It is not an Attempt and counts toward no ticket's cap.
_Avoid_: conflict attempt (Attempts are ticket-scoped; this is not one)

**Complete**:
Terminal state of a run: every ticket in Scope merged and closed.

**Stuck**:
Terminal state of a run: open tickets remain in Scope, but every path forward runs through a human. The run exits with a report of what is stuck on what.
_Avoid_: blocked (that's a ticket-level state, not a run-level one)
