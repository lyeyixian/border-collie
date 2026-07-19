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
 * The plan phase: a pure function from a world snapshot to the Actions now
 * due. Deterministic — lowest ticket numbers claim first.
 */
export function plan(world: WorldSnapshot, config: PlanConfig): Action[] {
  return dispatchableSet(world)
    .slice(0, Math.max(0, config.maxWorkers))
    .map((ticket) => ({ type: "claim", ticket: ticket.number }));
}
