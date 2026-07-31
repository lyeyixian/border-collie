import {
  type Action,
  CLAIM_LABEL,
  MAX_ATTEMPTS,
  type PlanConfig,
  READY_FOR_AGENT,
  type Ticket,
  type WorldSnapshot,
} from "./types.js";

/**
 * Dispatchable: open, unassigned (no human claim), unlabelled with the claim
 * label (no live or crashed-mid-write agent claim), labelled ready-for-agent,
 * all blockers closed. The dispatchable set is the only place the
 * Orchestrator takes work from; the concurrency caps decide how many
 * actually go each Tick.
 */
export function isDispatchable(ticket: Ticket): boolean {
  return (
    ticket.state === "open" &&
    ticket.assignees.length === 0 &&
    !ticket.labels.includes(CLAIM_LABEL) &&
    ticket.labels.includes(READY_FOR_AGENT) &&
    ticket.openBlockers === 0
  );
}

export function dispatchableSet(world: WorldSnapshot): Ticket[] {
  // A merged agent PR means the work is done and only closure is pending;
  // re-dispatching such a ticket would duplicate finished work.
  const merged = new Set(world.mergedAgentPrs.map((pr) => pr.ticket));
  return world.tickets
    .filter((ticket) => isDispatchable(ticket) && !merged.has(ticket.number))
    .sort((a, b) => a.number - b.number);
}

/**
 * Orphaned agent claim: an open ticket carrying both the claim label and the
 * claim marker but with no agent PR, open or merged — leftover from a
 * crashed run. (No live-Worker check yet: the stateless Orchestrator has no
 * Workers at Tick start until spawning lands with a later ticket. A
 * merged-PR claim is not orphaned: that ticket is done and merely awaiting
 * closure verification. Requiring the marker too — not just the label —
 * fails safe on a crash between the two claim writes: a labelled ticket with
 * no marker looks like an interrupted claim rather than a crashed run's
 * leftover, so it is left for a human to notice instead of auto-released.)
 * Released back to unclaimed; it rejoins the dispatchable set on the next
 * Tick's recomputed snapshot.
 */
/** True when a ticket has an open agent PR — the work may still land. */
function hasOpenAgentPr(world: WorldSnapshot, ticket: number): boolean {
  return world.openAgentPrs.some((pr) => pr.ticket === ticket);
}

/** True when a ticket has a merged agent PR — the work landed; only closure is pending. */
function hasMergedAgentPr(world: WorldSnapshot, ticket: number): boolean {
  return world.mergedAgentPrs.some((pr) => pr.ticket === ticket);
}

function isOrphanedClaim(ticket: Ticket, world: WorldSnapshot): boolean {
  return (
    ticket.state === "open" &&
    ticket.labels.includes(CLAIM_LABEL) &&
    ticket.hasAgentClaim &&
    !hasOpenAgentPr(world, ticket.number) &&
    !hasMergedAgentPr(world, ticket.number)
  );
}

/**
 * Attempts exhausted: an otherwise-dispatchable ticket whose claim history
 * already counts MAX_ATTEMPTS claims (each Attempt is preceded by exactly one
 * claim — the stateless attempt counter). Escalated instead of dispatched;
 * the label swap then removes it from the dispatchable set for good, so its
 * dependents stay blocked. Unassigned and unlabelled with the claim label:
 * a currently-held claim (human or agent) is released or hands off before
 * escalation is ever judged. An open agent PR vetoes: the work may still
 * land. A merged agent PR vetoes too: the work did land, and the ticket is
 * merely awaiting closure verification.
 */
function isEscalationDue(ticket: Ticket, world: WorldSnapshot): boolean {
  return (
    ticket.state === "open" &&
    ticket.assignees.length === 0 &&
    !ticket.labels.includes(CLAIM_LABEL) &&
    ticket.labels.includes(READY_FOR_AGENT) &&
    ticket.agentClaimCount >= MAX_ATTEMPTS &&
    !hasOpenAgentPr(world, ticket.number) &&
    !hasMergedAgentPr(world, ticket.number)
  );
}

/**
 * PR upkeep: after a merge advances the base, keep the remaining open agent
 * PRs current, one Action per PR at most. Conflict handling comes first and is
 * exclusive — a conflicted PR is neither updated nor readied until the merge is
 * resolved: a one-shot conflict Worker unless one has already asked for a
 * human. A cleanly-mergeable PR that has fallen behind gets the mechanical
 * branch update, and its ready flip waits for the next Tick, judged against the
 * updated head (the update re-runs CI). Draft→ready is otherwise decided on CI
 * alone — a green draft, or one in a repo with no CI configured, flips to
 * ready-for-review — and independent of mergeability, so a fresh no-CI draft
 * surfaces even while GitHub is still computing whether it is behind.
 */
function prUpkeep(world: WorldSnapshot): Action[] {
  const actions: Action[] = [];
  for (const pr of [...world.openAgentPrs].sort(
    (a, b) => a.number - b.number,
  )) {
    if (pr.mergeable === "conflicted") {
      if (!pr.conflictWorkerAsked) {
        actions.push({
          type: "conflict-worker",
          pr: pr.number,
          ticket: pr.ticket,
          headRef: pr.headRef,
        });
      }
      continue;
    }
    if (pr.mergeable === "mergeable" && pr.behind) {
      actions.push({ type: "update-branch", pr: pr.number, ticket: pr.ticket });
      continue;
    }
    if (pr.draft && (pr.ci === "passing" || pr.ci === "none")) {
      actions.push({ type: "mark-ready", pr: pr.number, ticket: pr.ticket });
    }
  }
  return actions;
}

/**
 * The plan phase: a pure function from a world snapshot to the Actions now
 * due. Deterministic — closure verification first (a merged PR whose ticket
 * stayed open freezes its dependents), then releases (recovery before new
 * work), then escalations (they free nothing and consume no Worker slots),
 * then lowest ticket numbers claim first, each claim paired with the spawn
 * of its Worker. The spawn's attempt number climbs the retry ladder: the
 * caller binds attempt ≥ 2 to the stronger retry model. Dispatch is capped
 * by both max_workers and the headroom left under max_open_prs: every spawn
 * becomes an open PR, so claiming only into that headroom throttles the
 * fleet to human review bandwidth, resuming as merges land. PR upkeep sits
 * between closure and recovery: it keeps the PRs a merge just left behind
 * current, and consumes no Worker slots (the conflict Worker aside). While the
 * circuit breaker is open (dispatchPaused) only closes are planned.
 */
export function plan(world: WorldSnapshot, config: PlanConfig): Action[] {
  const openTickets = new Set(
    world.tickets.filter((t) => t.state === "open").map((t) => t.number),
  );
  const closes: Action[] = world.mergedAgentPrs
    .filter((pr) => openTickets.has(pr.ticket))
    .sort((a, b) => a.ticket - b.ticket)
    .map((pr) => ({ type: "close", ticket: pr.ticket, prUrl: pr.url }));

  // Circuit breaker open: the environment is failing. Only closure
  // verification proceeds — releases are suppressed so infrastructure-voided
  // claims stay held (nothing else may grab those tickets mid-outage), and
  // escalations wait for a healthy environment rather than judging tickets
  // during one.
  if (config.dispatchPaused) return closes;

  const releases: Action[] = world.tickets
    .filter((ticket) => isOrphanedClaim(ticket, world))
    .sort((a, b) => a.number - b.number)
    .map((ticket) => ({ type: "release", ticket: ticket.number }));

  const escalations: Action[] = world.tickets
    .filter((ticket) => isEscalationDue(ticket, world))
    .sort((a, b) => a.number - b.number)
    .map((ticket) => ({
      type: "escalate",
      ticket: ticket.number,
      failures: ticket.attemptFailures,
    }));

  // The headroom counts open agent PRs repo-wide, not per Scope: the cap
  // models the human reviewer's bandwidth, and every agent PR occupies it
  // whichever run opened it.
  const headroom = Math.max(0, config.maxOpenPrs - world.openAgentPrs.length);
  const dispatches: Action[] = dispatchableSet(world)
    .filter((ticket) => ticket.agentClaimCount < MAX_ATTEMPTS)
    .slice(0, Math.max(0, Math.min(config.maxWorkers, headroom)))
    .flatMap((ticket) => [
      { type: "claim", ticket: ticket.number },
      {
        type: "spawn",
        ticket: ticket.number,
        attempt: ticket.agentClaimCount + 1,
      },
    ]);

  return [
    ...closes,
    ...prUpkeep(world),
    ...releases,
    ...escalations,
    ...dispatches,
  ];
}
