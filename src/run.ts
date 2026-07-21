import { renderStuck } from "./render.js";
import type { Action, Ticket, WorldSnapshot } from "./types.js";

/**
 * The resident loop: Tick, judge the world, sleep the poll interval, Tick
 * again — until a terminal state. Each Tick stays a single idempotent pass
 * (the same one the standalone command runs); the loop adds nothing but
 * repetition, so killing a run and re-running later loses nothing.
 */

export type RunStatus =
  | { state: "running" }
  | { state: "complete" }
  | { state: "stuck"; open: Ticket[] };

/**
 * Terminal-state judgment for a run, from the Tick's snapshot and plan.
 * Complete: every ticket in Scope is closed. Stuck: open tickets remain but
 * the Tick planned nothing and no agent PR is open — nothing is in flight
 * and nothing will change without a human. Anything else keeps polling; in
 * particular, open agent PRs awaiting human merge are the loop's normal
 * steady state, never an exit. (The refined Stuck semantics and the full
 * report land with the termination ticket.)
 */
export function runStatus(world: WorldSnapshot, actions: Action[]): RunStatus {
  const open = world.tickets.filter((ticket) => ticket.state === "open");
  if (open.length === 0) return { state: "complete" };
  if (actions.length === 0 && world.openAgentPrTickets.length === 0) {
    return { state: "stuck", open };
  }
  return { state: "running" };
}

export type RunOutcome = "complete" | "stuck";

/** The loop's effects, injectable for tests; `tick` is one full observe → plan → act pass. */
export interface RunDeps {
  tick: () => Promise<{ world: WorldSnapshot; actions: Action[] }>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export async function run(pollSeconds: number, deps: RunDeps): Promise<RunOutcome> {
  for (;;) {
    const { world, actions } = await deps.tick();
    const status = runStatus(world, actions);
    if (status.state === "complete") {
      deps.log("Run Complete: every ticket in Scope is closed.");
      return "complete";
    }
    if (status.state === "stuck") {
      deps.log(renderStuck(status.open));
      return "stuck";
    }
    deps.log(`Next Tick in ${pollSeconds}s.`);
    await deps.sleep(pollSeconds * 1000);
  }
}
