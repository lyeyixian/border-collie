# Handoff: build a ticket-fleet orchestrator (new repo)

**Next session's goal:** design and build, in a fresh dedicated repo, an orchestration loop that implements a set of tracer-bullet tickets (as produced by the Matt Pocock `/to-tickets` skill) with a fleet of Claude Code agents, respecting blocking dependencies, until every ticket is merged and closed.

## Where this came from

A Q&A session over the Matt Pocock skills plugin (`mattpocock-skills` v1.2.0) established that **no existing skill does this orchestration** — the kit deliberately stops at a scheduler-friendly data model and a serial, human-driven loop ("work the frontier one ticket at a time with `/implement`, clearing context between tickets"). The orchestrator is the missing outer loop.

Skill definitions referenced (read these, don't trust summaries):

- `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.0/skills/engineering/to-tickets/SKILL.md`
- `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.0/skills/engineering/implement/SKILL.md`
- `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.0/skills/engineering/wayfinder/SKILL.md` (for the claim-by-assignment protocol)
- `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.0/skills/engineering/ask-matt/SKILL.md` (the flow map)

## Established facts the design rests on

1. **The ticket data model is orchestrator-ready by construction.** `/to-tickets` publishes one issue per ticket on the configured tracker (GitHub Issues in the source project), in dependency order, using the platform's **native blocking / sub-issue links**, labelled `ready-for-agent`. Each ticket is a vertical slice sized to one fresh ~100K-token context window.
2. **The frontier** = open tickets whose blockers are all closed. It is queryable via `gh` (issue list + blocking relationships) and recomputable after every merge.
3. **Claim protocol** (borrowed from wayfinder): assign the issue to the working identity *before* any work; an open, unassigned, unblocked ticket is grabbable. This is what makes concurrent workers safe.
4. **`/implement` is intentionally thin**: drive `/tdd` at pre-agreed seams, typecheck regularly, full suite once at the end, `/code-review` (Standards + Spec axes), then **commit to the current branch — it does not push, open a PR, merge, or close the ticket**. The orchestrator owns everything after the commit.
5. **Context hygiene is non-negotiable**: one ticket per fresh agent session. Never feed a worker more than its ticket (plus repo context it discovers itself).
6. Tickets from `/to-tickets` are already agent-ready — **never route them through `/triage`**.

## The loop to build (dispatcher design agreed in discussion)

```
while open tickets remain:
  frontier = open ∧ unassigned ∧ ready-for-agent ∧ all blockers closed
  for each frontier ticket (up to concurrency cap):
    claim (assign) → spawn isolated worker (fresh context, own git worktree/branch)
    worker: run /implement against the ticket → push branch → open DRAFT PR linking the ticket
  wait for PRs to merge; on merge → close ticket → recompute frontier
```

Design decisions already taken:

- **Merging stays human** (at least in v1). `/code-review` is advisory; auto-merging agent PRs is a policy call the skill kit deliberately avoids. The orchestrator dispatches and monitors; a human merges.
- **Isolation via git worktrees** — parallel workers must not collide. Claude Code background jobs / headless `claude -p` runs with worktree isolation are the expected worker substrate; `gh` CLI is the tracker interface.
- Ticket closure should follow the **merge**, not the commit — "done" means merged and closed, matching the original goal.

## Open questions for the new session to grill on

- Worker substrate: headless `claude -p` invocations from a script, Claude Code background jobs, or the Agent/Workflow tools from inside a session?
- Concurrency cap and what happens when a worker fails or stalls (retry? release the claim? escalate?).
- How the orchestrator detects merges (poll vs. webhook) and whether it should also rebase/kick stale PRs when an earlier merge changes the base.
- Whether closing the ticket is automated on merge (GitHub "closes #N" in the PR body would do this for free).
- Target-repo assumptions: does the orchestrator only support GitHub Issues + native blocking, or abstract over trackers like `/setup-matt-pocock-skills` does?

## Suggested skills for the next session

- `/grill-me` first — the new repo is empty, so the stateless interview is the right sharpener for the orchestrator's design (switch to `/grill-with-docs` once the repo exists and is set up).
- `/setup-matt-pocock-skills` in the new repo before any engineering flow.
- Then the main flow: `/to-spec` → `/to-tickets` → `/implement` per ticket (the orchestrator can dogfood its own ticket set).
- `/prototype` if the dispatcher's state model (claiming, failure, merge detection) feels unsettled on paper.
