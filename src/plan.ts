import {
  MAX_ATTEMPTS,
  READY_FOR_AGENT,
  type Action,
  type PlanConfig,
  type Ticket,
  type WorldSnapshot,
} from "./types.js";

/**
 * Dispatchable: open, unassigned, labelled ready-for-agent, all blockers
 * closed. The dispatchable set is the only place the Orchestrator takes
 * work from; the concurrency caps decide how many actually go each Tick.
 */
export function isDispatchable(ticket: Ticket): boolean {
  return (
    ticket.state === "open" &&
    ticket.assignees.length === 0 &&
    ticket.labels.includes(READY_FOR_AGENT) &&
    ticket.openBlockers === 0
  );
}

export function dispatchableSet(world: WorldSnapshot): Ticket[] {
  return world.tickets
    .filter(isDispatchable)
    .sort((a, b) => a.number - b.number);
}

/**
 * Orphaned agent claim: an open ticket carrying the claim marker but with no
 * open agent PR — leftover from a crashed run. (No live-Worker check yet:
 * the stateless Orchestrator has no Workers at Tick start until spawning
 * lands with a later ticket.) Released back to unassigned; it rejoins the
 * dispatchable set on the next Tick's recomputed snapshot.
 */
function isOrphanedClaim(ticket: Ticket, world: WorldSnapshot): boolean {
  return (
    ticket.state === "open" &&
    ticket.assignees.length > 0 &&
    ticket.hasAgentClaim &&
    !world.openAgentPrTickets.includes(ticket.number)
  );
}

/**
 * Attempts exhausted: an otherwise-dispatchable ticket whose claim history
 * already counts MAX_ATTEMPTS claims (each Attempt is preceded by exactly one
 * claim — the stateless attempt counter). Escalated instead of dispatched;
 * the label swap then removes it from the dispatchable set for good, so its
 * dependents stay blocked. An open agent PR vetoes: the work may still land.
 */
function isEscalationDue(ticket: Ticket, world: WorldSnapshot): boolean {
  return (
    ticket.state === "open" &&
    ticket.assignees.length === 0 &&
    ticket.labels.includes(READY_FOR_AGENT) &&
    ticket.agentClaimCount >= MAX_ATTEMPTS &&
    !world.openAgentPrTickets.includes(ticket.number)
  );
}

/**
 * The plan phase: a pure function from a world snapshot to the Actions now
 * due. Deterministic — releases first (recovery before new work), then
 * escalations (they free nothing and consume no Worker slots), then lowest
 * ticket numbers claim first, each claim paired with the spawn of its Worker.
 * The spawn's attempt number climbs the retry ladder: the caller binds
 * attempt ≥ 2 to the stronger retry model.
 */
export function plan(world: WorldSnapshot, config: PlanConfig): Action[] {
  const releases: Action[] = world.tickets
    .filter((ticket) => isOrphanedClaim(ticket, world))
    .sort((a, b) => a.number - b.number)
    .map((ticket) => ({ type: "release", ticket: ticket.number, assignees: ticket.assignees }));

  const escalations: Action[] = world.tickets
    .filter((ticket) => isEscalationDue(ticket, world))
    .sort((a, b) => a.number - b.number)
    .map((ticket) => ({
      type: "escalate",
      ticket: ticket.number,
      failures: ticket.attemptFailures,
    }));

  const dispatches: Action[] = dispatchableSet(world)
    .filter((ticket) => ticket.agentClaimCount < MAX_ATTEMPTS)
    .slice(0, Math.max(0, config.maxWorkers))
    .flatMap((ticket) => [
      { type: "claim", ticket: ticket.number },
      { type: "spawn", ticket: ticket.number, attempt: ticket.agentClaimCount + 1 },
    ]);

  return [...releases, ...escalations, ...dispatches];
}
