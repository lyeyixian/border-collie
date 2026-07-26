import { act } from "./act.js";
import { modelForAttempt, type ResolvedConfig } from "./config.js";
import { plan } from "./plan.js";
import { openPrForOutcome } from "./pr.js";
import { renderPlan } from "./render.js";
import { readScope } from "./tracker.js";
import type { Action, WorldSnapshot } from "./types.js";
import { dispatchConflictWorker, dispatchWorker } from "./worker.js";

/** One full observe → plan → act pass — the single Tick both commands share. */
export async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
  log: (line: string) => void,
): Promise<{ world: WorldSnapshot; actions: Action[]; infraFailures: number }> {
  const world = await readScope(config.scope);
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused,
  });
  log(renderPlan(config, world, actions, { dryRun, dispatchPaused }));
  let infraFailures = 0;
  if (!dryRun) {
    const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
    const report = await act(
      actions,
      (ticket, attempt) =>
        dispatchWorker(ticket, {
          model: modelForAttempt(config, attempt),
          attempt,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          maxCostUsd: config.maxCostUsd,
        }),
      (outcome) =>
        openPrForOutcome(
          outcome,
          titles.get(outcome.ticket) ?? `Ticket #${outcome.ticket}`,
        ),
      (pr, ticket, headRef) =>
        dispatchConflictWorker(pr, ticket, headRef, {
          model: config.model,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
        }),
      undefined,
      log,
    );
    infraFailures = report.infraFailures;
  }
  return { world, actions, infraFailures };
}
