import { openPrForOutcome } from "../adapters/pr.js";
import { readScope, realExec, withDebugLogging } from "../adapters/tracker.js";
import {
  dispatchConflictWorker,
  dispatchRefinementWorker,
  dispatchRemoteWorker,
  dispatchWorker,
  realSpawnWorkerProcess,
} from "../adapters/worker.js";
import { deriveBreaker, probeDue } from "../core/breaker.js";
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
  /**
   * True when this Tick runs as the Orchestrator's own GitHub Actions job
   * (issue #74): a Ticket dispatch triggers the Worker's job and returns
   * (`dispatchRemoteWorker`) instead of running headless claude to
   * completion in-process (`dispatchWorker`). Conflict and Refinement
   * Workers are unaffected either way — they stay cheap enough to run inline
   * in whichever process the Tick itself is. Left undefined (falsy) by every
   * caller but the real composition root, so the resident run loop and a
   * manually-run tick keep today's synchronous local path.
   */
  remoteDispatch?: boolean;
}

/**
 * What one Tick came to, returned to both the standalone command and the
 * resident loop. `dispatchPaused` is what this Tick actually planned with —
 * the caller's own `dispatchPaused` OR'd with the tracker-derived breaker
 * (see `tickOnce` below) — so a caller with no breaker memory of its own, or
 * one that hasn't caught up yet, can still judge Stuck against what was
 * really planned rather than against its own memory alone.
 */
export interface TickResult {
  world: WorldSnapshot;
  actions: Action[];
  infraFailures: number;
  dispatchPaused: boolean;
}

/** One full observe → plan → act pass — the single Tick both commands share. */
export async function tickOnce(
  config: ResolvedConfig,
  dryRun: boolean,
  dispatchPaused = false,
  deps: TickDeps,
): Promise<TickResult> {
  const { log, now, scheduleInterval, remoteDispatch = false } = deps;
  // Every command this Tick issues through the adapters — gh and git alike
  // — plus its exit code, is narrated at debug through the same seam:
  // detail that does not exist today, hidden from the console unless
  // --verbose is passed.
  const exec = withDebugLogging(realExec, log);
  const world = await readScope(config.scope, exec);
  // Resolved fresh against wall-clock time each Tick (CONTEXT.md "Working
  // hours") — not encoded in a cron expression.
  const withinWorkingHours = isWithinWorkingHours(config.workingHours, now());
  // Always derived, regardless of what the caller already knows (see
  // `deriveBreaker`'s own doc for why this reaches the same verdict either way).
  const derivedBreaker = deriveBreaker(world);
  const derivedPause =
    derivedBreaker !== undefined && !probeDue(derivedBreaker, now());
  const effectiveDispatchPaused = dispatchPaused || derivedPause;
  const actions = plan(world, {
    maxWorkers: config.maxWorkers,
    maxOpenPrs: config.maxOpenPrs,
    dispatchPaused: effectiveDispatchPaused,
    withinWorkingHours,
  });
  const planReport = buildPlanReport(config, world, actions, {
    dryRun,
    dispatchPaused: effectiveDispatchPaused,
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
      dispatch: remoteDispatch
        ? (ticket, attempt) => dispatchRemoteWorker(ticket, attempt, exec)
        : (ticket, attempt, onActivity) =>
            dispatchWorker(
              ticket,
              {
                model: modelForAttempt(config, attempt),
                attempt,
                timeoutMs: config.timeoutMinutes * 60_000,
                stallMs: config.stallMinutes * 60_000,
                maxTurns: config.maxTurns,
                maxCostUsd: config.maxCostUsd,
                // A Tick may dispatch several Workers concurrently into this
                // same checkout, so each still needs its own isolated worktree —
                // never in-place (that path is a Worker job's own dedicated
                // checkout; see src/app/worker.ts).
                inPlace: false,
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
      dispatchRefinement: (pr, ticket, headRef, round) =>
        dispatchRefinementWorker(
          pr,
          ticket,
          headRef,
          round,
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
  return {
    world,
    actions,
    infraFailures,
    dispatchPaused: effectiveDispatchPaused,
  };
}
