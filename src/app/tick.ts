import { openPrForOutcome } from "../adapters/pr.js";
import { readScope, realExec } from "../adapters/tracker.js";
import { dispatchConflictWorker, dispatchWorker } from "../adapters/worker.js";
import { modelForAttempt, type ResolvedConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import { plan } from "../core/plan.js";
import { renderPlan } from "../core/render.js";
import type { Action, WorldSnapshot } from "../core/types.js";
import { act } from "./act.js";

/** One full observe → plan → act pass — the single Tick both commands share. */
export async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
  log: Log,
): Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }> {
  const world = await readScope(config.scope);
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused,
  });
  log({
    kind: "plan-report",
    level: "info",
    msg: renderPlan(config, world, actions, { dryRun, dispatchPaused }),
  });
  let infraFailures = 0;
  if (!dryRun) {
    const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
    const report = await act(actions, {
      dispatch: (ticket, attempt) =>
        dispatchWorker(ticket, {
          model: modelForAttempt(config, attempt),
          attempt,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          maxCostUsd: config.maxCostUsd,
        }),
      openPr: (outcome) =>
        openPrForOutcome(
          outcome,
          titles.get(outcome.ticket) ?? `Ticket #${outcome.ticket}`,
        ),
      dispatchConflict: (pr, ticket, headRef) =>
        dispatchConflictWorker(pr, ticket, headRef, {
          model: config.model,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
        }),
      exec: realExec,
      log,
    });
    infraFailures = report.infraFailures;
  }
  return { world, actions, infraFailures };
}
