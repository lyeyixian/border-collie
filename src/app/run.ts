import {
  type Breaker,
  breakerCooldownMs,
  probeDue,
  tripBreaker,
} from "../core/breaker.js";
import type { Log } from "../core/log.js";
import { dispatchableSet } from "../core/plan.js";
import { buildCompleteReport, buildStuckReport } from "../core/render.js";
import type { Action, Ticket, WorldSnapshot } from "../core/types.js";

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
 * nothing can move without a human — the Tick planned nothing (no close,
 * release, escalation, or dispatch was due), no in-Scope agent PR is open
 * (a foreign run's PRs cannot close a ticket here, so they never keep a
 * dead Scope polling), and nothing is dispatchable (a dispatchable ticket
 * merely throttled by max_open_prs headroom becomes claimable when PRs
 * merge, wherever those PRs came from). No Worker runs at this point by
 * construction: the Tick waits for every Worker it spawned before
 * returning. Anything else keeps polling; in particular, open agent PRs
 * awaiting human merge are the loop's normal steady state, never an exit —
 * and an open circuit breaker is never Stuck: the path forward is the
 * environment recovering, not a human.
 */
export function runStatus(
  world: WorldSnapshot,
  actions: Action[],
  dispatchPaused = false,
): RunStatus {
  const open = world.tickets.filter((ticket) => ticket.state === "open");
  if (open.length === 0) return { state: "complete" };
  const inScope = new Set(world.tickets.map((ticket) => ticket.number));
  const openScopePrs = world.openAgentPrs.filter((pr) =>
    inScope.has(pr.ticket),
  );
  if (
    actions.length === 0 &&
    openScopePrs.length === 0 &&
    dispatchableSet(world).length === 0 &&
    !dispatchPaused
  ) {
    return { state: "stuck", open };
  }
  return { state: "running" };
}

export type RunOutcome = "complete" | "stuck";

/** The loop's effects, injectable for tests; `tick` is one full observe → plan → act pass. */
export interface RunDeps {
  tick: (dispatchPaused: boolean) => Promise<{
    world: WorldSnapshot;
    actions: Action[];
    infraFailures: number;
  }>;
  /** The circuit breaker's recovery probe: true when the environment answers. */
  probe: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Log;
}

export async function run(
  pollSeconds: number,
  deps: RunDeps,
): Promise<RunOutcome> {
  let breaker: Breaker;
  for (;;) {
    if (breaker !== undefined && probeDue(breaker, deps.now())) {
      if (await deps.probe()) {
        breaker = undefined;
        deps.log({
          kind: "breaker-closed",
          level: "info",
          msg: "circuit breaker closed: the environment recovered — dispatch resumes.",
        });
      } else {
        breaker = tripBreaker(breaker, deps.now());
        const nextProbeMs = breakerCooldownMs(breaker.trips);
        deps.log({
          kind: "breaker-still-open",
          level: "warn",
          msg: `circuit breaker still open: the probe failed — next probe in ${Math.round(nextProbeMs / 60_000)}m.`,
          trips: breaker.trips,
          nextProbeMs,
        });
      }
    }
    const { world, actions, infraFailures } = await deps.tick(
      breaker !== undefined,
    );
    if (infraFailures > 0) {
      breaker = tripBreaker(breaker, deps.now());
      const nextProbeMs = breakerCooldownMs(breaker.trips);
      deps.log({
        kind: "breaker-open",
        level: "warn",
        msg: `circuit breaker open: ${infraFailures} infrastructure failure${infraFailures === 1 ? "" : "s"} this Tick — dispatch paused, claims held, probing in ${Math.round(nextProbeMs / 60_000)}m.`,
        infraFailures,
        nextProbeMs,
      });
    }
    const status = runStatus(world, actions, breaker !== undefined);
    if (status.state === "complete") {
      const completeReport = buildCompleteReport(world.tickets);
      deps.log({
        kind: "complete-report",
        level: "info",
        msg: "run complete",
        report: completeReport,
      });
      return "complete";
    }
    if (status.state === "stuck") {
      const stuckReport = buildStuckReport(world);
      deps.log({
        kind: "stuck-report",
        level: "warn",
        msg: "run stuck",
        report: stuckReport,
      });
      return "stuck";
    }
    deps.log({
      kind: "next-tick",
      level: "info",
      msg: `Next Tick in ${pollSeconds}s.`,
      pollSeconds,
    });
    deps.log({
      kind: "tick-wait",
      level: "debug",
      msg: `waiting ${pollSeconds}s before the next Tick`,
      pollSeconds,
    });
    await deps.sleep(pollSeconds * 1000);
  }
}
