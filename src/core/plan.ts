import {
  type Action,
  CLAIM_LABEL,
  MAX_ATTEMPTS,
  MAX_REFINEMENT_ROUNDS,
  type OpenAgentPr,
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
 * True when the operator has something to merge right now — the mergeable
 * gate (ADR 0007), which is closed exactly while this holds. A conflicted PR
 * cannot be merged, so resolving one while a sibling is mergeable is
 * speculation the very next merge invalidates. A PR whose mergeability GitHub
 * has not finished computing counts as mergeable here: it may turn out to be,
 * and it self-clears within a Tick or two.
 */
function hasMergeablePr(world: WorldSnapshot): boolean {
  return world.openAgentPrs.some((pr) => pr.mergeable !== "conflicted");
}

/**
 * Dependents per ticket: the blocked-by edges the snapshot already carries,
 * inverted. A pure computation over data this Tick has already fetched — the
 * front-runner ordering costs no additional tracker read.
 */
function dependentCounts(tickets: Ticket[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const ticket of tickets) {
    for (const blocker of ticket.blockedBy) {
      counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Every conflicted PR still eligible for automatic handling — a Worker
 * already handed the rest to a human (the unresolved marker), which takes
 * them out of both the front-runner race and the queue behind it, since
 * waiting on a human is not waiting for a turn. Ordered by the same
 * deterministic rule the rest of the plan phase uses: the PR whose merge
 * unblocks the most downstream Tickets first, lowest PR number breaking
 * ties. The head of this ordering is the front-runner; every PR after it is
 * queued behind it (`queuedBehindActions` below).
 */
function conflictQueueOrder(world: WorldSnapshot): OpenAgentPr[] {
  const counts = dependentCounts(world.tickets);
  const dependents = (pr: OpenAgentPr) => counts.get(pr.ticket) ?? 0;
  return world.openAgentPrs
    .filter((pr) => pr.mergeable === "conflicted" && !pr.conflictWorkerAsked)
    .sort((a, b) => dependents(b) - dependents(a) || a.number - b.number);
}

/**
 * Conflict scheduling: the repo-wide half of PR upkeep, and the one decision
 * in it that cannot be made per PR. At most one Conflict Worker goes per
 * Tick, and only while nothing is mergeable — the invariant of ADR 0007,
 * stated as a property of the world snapshot rather
 * than as a lock, so it needs nothing held between Ticks and a restarted
 * Orchestrator reaches the same verdict (ADR 0001). It is deliberately
 * stronger than "one at a time": a conflicted PR also waits behind a sibling
 * that is merely mergeable and unmerged, including one that is mergeable but
 * still a draft.
 *
 * The Worker goes to the front-runner of `conflictQueueOrder`.
 *
 * The Conflict Worker is quota-consuming, so the working-hours gate
 * (CONTEXT.md "Working hours") suppresses it, exactly as it suppresses claims,
 * spawns and Refinement rounds.
 */
function conflictScheduling(
  world: WorldSnapshot,
  withinWorkingHours: boolean,
): Action[] {
  if (withinWorkingHours || hasMergeablePr(world)) return [];
  const [frontRunner] = conflictQueueOrder(world);
  return frontRunner
    ? [
        {
          type: "conflict-worker",
          pr: frontRunner.number,
          ticket: frontRunner.ticket,
          headRef: frontRunner.headRef,
        },
      ]
    : [];
}

/**
 * Queued-behind marking: every conflicted PR behind the front-runner gets an
 * Action naming it, so a pull request left waiting many Ticks reads as
 * waiting rather than forgotten (ADR 0007). Unlike the Conflict Worker
 * itself, this is mechanical bookkeeping, not a quota-consuming action — the
 * working-hours gate does not suppress it, the same reasoning that keeps
 * Refinement give-up unsuppressed — and it is independent of whether the
 * mergeable gate is currently open: the front-runner is still the front-
 * runner, and everyone else is still behind it, whether or not a Worker
 * actually dispatches to it this Tick.
 *
 * Idempotent by front-runner identity rather than by episode timing
 * (`OpenAgentPr.queuedBehindNotified`): a PR waits behind exactly one
 * comment as long as the front-runner it names stays the front-runner, and
 * becomes eligible for a fresh one the moment that name would change —
 * whether because the front-runner it was queued behind resolved, merged, or
 * was handed to a human and a new one took its place, or because this PR
 * left the queue entirely and later re-entered behind a different PR. A PR
 * that leaves and rejoins the queue behind the *same* front-runner, with
 * nothing else changing, gets no repeat: the existing comment is still
 * accurate, so there is nothing fresh to say.
 */
function queuedBehindActions(world: WorldSnapshot): Action[] {
  const [frontRunner, ...waiting] = conflictQueueOrder(world);
  if (!frontRunner) return [];
  return waiting
    .filter((pr) => pr.queuedBehindNotified !== frontRunner.number)
    .map((pr) => ({
      type: "queued-behind",
      pr: pr.number,
      ticket: pr.ticket,
      queuedBehind: frontRunner.number,
    }));
}

/**
 * PR upkeep: after a merge advances the base, keep the remaining open agent
 * PRs current — mechanical writes plus the two Refinement actions, up to one
 * of each kind per PR. Conflict handling is exclusive and is scheduled
 * repo-wide instead (`conflictScheduling`): a conflicted PR is neither
 * updated, readied, nor Refined until the merge is resolved, so this loop
 * skips it entirely. A cleanly-mergeable PR that has fallen behind gets the
 * mechanical branch update, and its ready flip waits for the next Tick, judged
 * against the updated head (the update re-runs CI). Draft→ready is otherwise
 * decided on CI alone — a green draft, or one in a repo with no CI configured,
 * flips to ready-for-review — and independent of mergeability, so a fresh
 * no-CI draft surfaces even while GitHub is still computing whether it is
 * behind.
 *
 * Refinement (CONTEXT.md "Refinement round") is judged independently of the
 * ready flip — a failing check keeps `pr.draft && ci === "passing"` false
 * regardless, so the two never collide — for every PR not carrying the
 * operator-steered label and not already given up on: `triggerDue` false
 * means nothing is due; `triggerDue` true with rounds already at
 * MAX_REFINEMENT_ROUNDS means Refinement give-up (CONTEXT.md "Refinement
 * give-up"), handing the Ticket to a human; otherwise a round is due.
 *
 * A Refinement round is quota-consuming, so the working-hours gate (CONTEXT.md
 * "Working hours") suppresses it — as it does the Conflict Worker; the
 * mechanical update, the ready flip, and Refinement give-up are not — give-up
 * is mechanical bookkeeping, the same reasoning that keeps Escalation
 * unsuppressed — and run regardless.
 */
function prUpkeep(world: WorldSnapshot, withinWorkingHours: boolean): Action[] {
  const actions: Action[] = [];
  for (const pr of [...world.openAgentPrs].sort(
    (a, b) => a.number - b.number,
  )) {
    if (pr.mergeable === "conflicted") continue;
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
 * fleet to human review bandwidth, resuming as merges land. Conflict
 * scheduling, queued-behind marking, and PR upkeep sit between closure and
 * recovery, in that order — the repo-wide conflict decision (at most one
 * Conflict Worker a Tick, and only while nothing is mergeable), then marking
 * every other conflicted PR with the front-runner it waits on, ahead of the
 * mechanical per-PR writes that keep the PRs a merge just left behind
 * current. None of the three consumes a Worker slot (the conflict Worker
 * aside). While the circuit breaker is open (dispatchPaused) only closes are
 * planned. The working-hours gate (CONTEXT.md "Working hours",
 * withinWorkingHours) is a narrower, independent suppression: only the
 * quota-consuming actions — claims, spawns, the conflict Worker — drop out,
 * so closes, releases, escalations, queued-behind marking, and the rest of PR
 * upkeep keep the world current while the fleet is quiet.
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
    ...conflictScheduling(world, withinWorkingHours),
    ...queuedBehindActions(world),
    ...prUpkeep(world, withinWorkingHours),
    ...releases,
    ...escalations,
    ...dispatches,
  ];
}
