import { breakerCooldownMs, probeDue, tripBreaker, type Breaker } from "./breaker.js";
import { renderStuck } from "./render.js";
import type { Action, Ticket, WorldSnapshot } from "./types.js";

/**
 * The resident loop: Tick, judge the world, sleep the poll interval, Tick
 * again — until a terminal state. Each Tick stays a single idempotent pass
 * (the same one the standalone command runs); the loop adds repetition plus
 * the circuit breaker — the one piece of state that is genuinely about this
 * process's environment, not the world, so it lives here in memory and not
 * on the tracker (ADR 0001). Killing a run and re-running later loses
 * nothing: a lost breaker merely re-trips at worst one voided Attempt later.
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
 * steady state, never an exit — and an open circuit breaker is never Stuck:
 * the path forward is the environment recovering, not a human.
 */
export function runStatus(
  world: WorldSnapshot,
  actions: Action[],
  dispatchPaused = false,
): RunStatus {
  const open = world.tickets.filter((ticket) => ticket.state === "open");
  if (open.length === 0) return { state: "complete" };
  if (actions.length === 0 && world.openAgentPrs.length === 0 && !dispatchPaused) {
    return { state: "stuck", open };
  }
  return { state: "running" };
}

export type RunOutcome = "complete" | "stuck";

/** The loop's effects, injectable for tests; `tick` is one full observe → plan → act pass. */
export interface RunDeps {
  tick: (
    dispatchPaused: boolean,
  ) => Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }>;
  /** The circuit breaker's recovery probe: true when the environment answers. */
  probe: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export async function run(pollSeconds: number, deps: RunDeps): Promise<RunOutcome> {
  let breaker: Breaker;
  for (;;) {
    if (breaker !== undefined && probeDue(breaker, deps.now())) {
      if (await deps.probe()) {
        breaker = undefined;
        deps.log("circuit breaker closed: the environment recovered — dispatch resumes.");
      } else {
        breaker = tripBreaker(breaker, deps.now());
        deps.log(
          `circuit breaker still open: the probe failed — next probe in ${Math.round(breakerCooldownMs(breaker.trips) / 60_000)}m.`,
        );
      }
    }
    const { world, actions, infraFailures } = await deps.tick(breaker !== undefined);
    if (infraFailures > 0) {
      breaker = tripBreaker(breaker, deps.now());
      deps.log(
        `circuit breaker open: ${infraFailures} infrastructure failure${infraFailures === 1 ? "" : "s"} this Tick — dispatch paused, claims held, probing in ${Math.round(breakerCooldownMs(breaker.trips) / 60_000)}m.`,
      );
    }
    const status = runStatus(world, actions, breaker !== undefined);
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
