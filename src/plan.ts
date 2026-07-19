import {
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
 * The plan phase: a pure function from a world snapshot to the Actions now
 * due. Deterministic — releases first (recovery before new work), then
 * lowest ticket numbers claim first, each claim paired with the spawn of
 * its Worker.
 */
export function plan(world: WorldSnapshot, config: PlanConfig): Action[] {
  const releases: Action[] = world.tickets
    .filter((ticket) => isOrphanedClaim(ticket, world))
    .sort((a, b) => a.number - b.number)
    .map((ticket) => ({ type: "release", ticket: ticket.number, assignees: ticket.assignees }));

  const dispatches: Action[] = dispatchableSet(world)
    .slice(0, Math.max(0, config.maxWorkers))
    .flatMap((ticket) => [
      { type: "claim", ticket: ticket.number },
      { type: "spawn", ticket: ticket.number },
    ]);

  return [...releases, ...dispatches];
}
