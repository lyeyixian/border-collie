import { openPrForOutcome } from "../adapters/pr.js";
import { readScope, realExec, withDebugLogging } from "../adapters/tracker.js";
import { dispatchConflictWorker, dispatchWorker } from "../adapters/worker.js";
import { modelForAttempt, type ResolvedConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import { plan } from "../core/plan.js";
import { buildPlanReport } from "../core/render.js";
import type { Action, WorldSnapshot } from "../core/types.js";
import { act } from "./act.js";

/** One full observe → plan → act pass — the single Tick both commands share. */
export async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
  log: Log,
): Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }> {
  // Every tracker command this Tick issues, plus its exit code, is narrated
  // at debug through the same seam — detail that does not exist today, kept
  // out of the default console but always in the durable file.
  const exec = withDebugLogging(realExec, log);
  const world = await readScope(config.scope, exec);
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused,
  });
  const planReport = buildPlanReport(config, world, actions, {
    dryRun,
    dispatchPaused,
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
      dispatch: (ticket, attempt) =>
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
          undefined,
          undefined,
          log,
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
          undefined,
          undefined,
          log,
        ),
      exec,
      log,
    });
    infraFailures = report.infraFailures;
  }
  return { world, actions, infraFailures };
}
