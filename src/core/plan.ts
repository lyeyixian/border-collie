import {
  type Action,
  CLAIM_LABEL,
  MAX_ATTEMPTS,
  MAX_REFINEMENT_ROUNDS,
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
 * claim marker, no agent PR (open or merged), and no Worker job still live —
 * leftover from a crashed or finished-without-reporting run. A merged-PR
 * claim is not orphaned: that ticket is done and merely awaiting closure
 * verification. Requiring the marker too — not just the label — fails safe
 * on a crash between the two claim writes: a labelled ticket with no marker
 * looks like an interrupted claim rather than a crashed run's leftover, so it
 * is left for a human to notice instead of auto-released. The live-Worker
 * check (`Ticket.hasLiveWorker`, issue #73) is what keeps this from firing
 * against a claim whose Worker is still actually running: dispatch is now
 * fire-and-forget, so by the time this Tick observes the ticket, its Worker
 * may not have finished (and thus opened no PR) yet — a promise once held
 * only in the Orchestrator's memory would have blocked here in-process, but
 * a self-reporting Worker gives that memory nothing to hold. Once GitHub
 * itself marks the job no longer live with still no PR and no report, this
 * releases it, whether the Worker crashed or simply never wrote back.
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
    !ticket.hasLiveWorker &&
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
 * PRs current — mechanical writes plus the two Refinement actions, up to one
 * of each kind per PR. Conflict handling comes first and is exclusive — a
 * conflicted PR is neither updated, readied, nor Refined until the merge is
 * resolved: a one-shot conflict Worker unless one has already asked for a
 * human. A cleanly-mergeable PR that has fallen behind gets the mechanical
 * branch update, and its ready flip waits for the next Tick, judged against the
 * updated head (the update re-runs CI). Draft→ready is otherwise decided on CI
 * alone — a green draft, or one in a repo with no CI configured, flips to
 * ready-for-review — and independent of mergeability, so a fresh no-CI draft
 * surfaces even while GitHub is still computing whether it is behind.
 *
 * Refinement (CONTEXT.md "Refinement round") is judged independently of the
 * ready flip — a failing check keeps `pr.draft && ci === "passing"` false
 * regardless, so the two never collide — for every PR not carrying the
 * operator-steered label and not already given up on: `triggerDue` false
 * means nothing is due; `triggerDue` true with rounds already at
 * MAX_REFINEMENT_ROUNDS means Refinement give-up (CONTEXT.md "Refinement
 * give-up"), handing the Ticket to a human; otherwise a round is due.
 *
 * The Conflict Worker and a Refinement round are both quota-consuming, so the
 * working-hours gate (CONTEXT.md "Working hours") suppresses them; the
 * mechanical update, the ready flip, and Refinement give-up are not — give-up
 * is mechanical bookkeeping, the same reasoning that keeps Escalation
 * unsuppressed — and run regardless.
 */
function prUpkeep(world: WorldSnapshot, withinWorkingHours: boolean): Action[] {
  const actions: Action[] = [];
  for (const pr of [...world.openAgentPrs].sort(
    (a, b) => a.number - b.number,
  )) {
    if (pr.mergeable === "conflicted") {
      if (!pr.conflictWorkerAsked && !withinWorkingHours) {
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
    if (
      !pr.operatorSteered &&
      !pr.refinement.givenUp &&
      pr.refinement.triggerDue
    ) {
      if (pr.refinement.rounds >= MAX_REFINEMENT_ROUNDS) {
        actions.push({
          type: "refinement-give-up",
          pr: pr.number,
          ticket: pr.ticket,
          rounds: pr.refinement.rounds,
        });
      } else if (!withinWorkingHours) {
        actions.push({
          type: "refine-pr",
          pr: pr.number,
          ticket: pr.ticket,
          headRef: pr.headRef,
          round: pr.refinement.rounds + 1,
        });
      }
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
 * circuit breaker is open (dispatchPaused) only closes are planned. The
 * working-hours gate (CONTEXT.md "Working hours", withinWorkingHours) is a
 * narrower, independent suppression: only the quota-consuming actions —
 * claims, spawns, the conflict Worker — drop out, so closes, releases,
 * escalations, and the rest of PR upkeep keep the world current while the
 * fleet is quiet.
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

  const withinWorkingHours = config.withinWorkingHours ?? false;

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
  const dispatches: Action[] = withinWorkingHours
    ? []
    : dispatchableSet(world)
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
    ...prUpkeep(world, withinWorkingHours),
    ...releases,
    ...escalations,
    ...dispatches,
  ];
}
