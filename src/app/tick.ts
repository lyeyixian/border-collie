import { openPrForOutcome } from "../adapters/pr.js";
import { readScope, realExec, withDebugLogging } from "../adapters/tracker.js";
import {
  dispatchConflictWorker,
  dispatchWorker,
  realSpawnWorkerProcess,
} from "../adapters/worker.js";
import { modelForAttempt, type ResolvedConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import { plan } from "../core/plan.js";
import { buildPlanReport } from "../core/render.js";
import type { Action, WorldSnapshot } from "../core/types.js";
import { isWithinWorkingHours } from "../core/work-hours.js";
import { act, type IntervalScheduler } from "./act.js";

/** The Tick's effects, injectable for tests, matching the run loop's pattern. */
export interface TickDeps {
  log: Log;
  now: () => number;
  scheduleInterval: IntervalScheduler;
}

/** One full observe → plan → act pass — the single Tick both commands share. */
export async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
  deps: TickDeps,
): Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }> {
  const { log, now, scheduleInterval } = deps;
  // Every command this Tick issues through the adapters — gh and git alike
  // — plus its exit code, is narrated at debug through the same seam:
  // detail that does not exist today, hidden from the console unless
  // --verbose is passed.
  const exec = withDebugLogging(realExec, log);
  const world = await readScope(config.scope, exec);
  // Resolved fresh against wall-clock time each Tick (CONTEXT.md "Working
  // hours") — not encoded in a cron expression.
  const withinWorkingHours = isWithinWorkingHours(config.workingHours, now());
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused,
    withinWorkingHours,
  });
  const planReport = buildPlanReport(config, world, actions, {
    dryRun,
    dispatchPaused,
    withinWorkingHours,
  });
  log({
    kind: "plan-report",
    level: "info",
    msg: "dispatch plan",
    report: planReport,
  });
  let infraFailures = 0;
  if (!dryRun) {
    const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
    const report = await act(actions, {
      dispatch: (ticket, attempt, onActivity) =>
        dispatchWorker(
          ticket,
          {
            model: modelForAttempt(config, attempt),
            attempt,
            timeoutMs: config.timeoutMinutes * 60_000,
            stallMs: config.stallMinutes * 60_000,
            maxTurns: config.maxTurns,
            maxCostUsd: config.maxCostUsd,
          },
          exec,
          realSpawnWorkerProcess,
          log,
          onActivity,
        ),
      openPr: (outcome) =>
        openPrForOutcome(
          outcome,
          titles.get(outcome.ticket) ?? `Ticket #${outcome.ticket}`,
          exec,
        ),
      dispatchConflict: (pr, ticket, headRef) =>
        dispatchConflictWorker(
          pr,
          ticket,
          headRef,
          {
            model: config.model,
            timeoutMs: config.timeoutMinutes * 60_000,
            stallMs: config.stallMinutes * 60_000,
            maxTurns: config.maxTurns,
          },
          exec,
          realSpawnWorkerProcess,
          log,
        ),
      exec,
      log,
      now,
      scheduleInterval,
    });
    infraFailures = report.infraFailures;
  }
  return { world, actions, infraFailures };
}
