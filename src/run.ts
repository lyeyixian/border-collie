import { dispatchableSet } from "./plan.js";
import { renderComplete, renderStuck } from "./render.js";
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
 * nothing can move without a human — the Tick planned nothing (no close,
 * release, escalation, or dispatch was due), no in-Scope agent PR is open
 * (a foreign run's PRs cannot close a ticket here, so they never keep a
 * dead Scope polling), and nothing is dispatchable (a dispatchable ticket
 * merely throttled by max_open_prs headroom becomes claimable when PRs
 * merge, wherever those PRs came from). No Worker runs at this point by
 * construction: the Tick waits for every Worker it spawned before
 * returning. Anything else keeps polling; in particular, open agent PRs
 * awaiting human merge are the loop's normal steady state, never an exit.
 */
export function runStatus(world: WorldSnapshot, actions: Action[]): RunStatus {
  const open = world.tickets.filter((ticket) => ticket.state === "open");
  if (open.length === 0) return { state: "complete" };
  const inScope = new Set(world.tickets.map((ticket) => ticket.number));
  const openScopePrs = world.openAgentPrTickets.filter((ticket) => inScope.has(ticket));
  if (actions.length === 0 && openScopePrs.length === 0 && dispatchableSet(world).length === 0) {
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
      deps.log(renderComplete(world.tickets));
      return "complete";
    }
    if (status.state === "stuck") {
      deps.log(renderStuck(status.open, world));
      return "stuck";
    }
    deps.log(`Next Tick in ${pollSeconds}s.`);
    await deps.sleep(pollSeconds * 1000);
  }
}
