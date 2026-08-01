import { openPrForOutcome } from "../adapters/pr.js";
import {
  type Exec,
  readTicketTitle,
  realExec,
  withDebugLogging,
} from "../adapters/tracker.js";
import { dispatchWorker, realSpawnWorkerProcess } from "../adapters/worker.js";
import { modelForAttempt, type WorkerAttemptConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import type { WorkerOutcome } from "../core/types.js";
import type { DispatchWorker, OpenPr } from "./act.js";
import { settleAttempt } from "./settle.js";

/**
 * A Worker settling its own Attempt (issue #71): the same `DispatchWorker`
 * and `OpenPr` seams the act phase spawns a batch of Workers through
 * (src/app/act.ts), injectable so a fake dispatch/openPr exercises this unit
 * without a real session.
 */
export interface WorkerAttemptDeps {
  dispatch: DispatchWorker;
  openPr: OpenPr;
  exec: Exec;
  log: Log;
}

/**
 * Run one Worker session against one Ticket and Attempt, then settle it:
 * open the draft PR on success, and either way hand the outcome to
 * `settleAttempt` — the same unit the act phase's batch settles through once
 * every Worker it spawned has finished (src/app/settle.ts) — so a Ticket
 * failure's forensic release and an Infrastructure failure's void are never
 * written twice. Unlike the act phase this has no fleet heartbeat and no
 * cross-Worker correlation: both depend on seeing a batch of concurrent
 * outcomes together, which a lone Worker settling itself never has. A PR
 * opening failure after a successful Attempt is narrated and rethrown, after
 * settling — mirroring the act phase's own treatment of the same failure.
 */
export async function runWorkerAttempt(
  ticket: number,
  attempt: number,
  deps: WorkerAttemptDeps,
): Promise<WorkerOutcome> {
  const { dispatch, openPr, exec, log } = deps;
  const outcome = await dispatch(ticket, attempt, () => {});
  let prUrl: string | undefined;
  let prFailure: unknown;
  if (outcome.ok) {
    try {
      prUrl = await openPr(outcome);
    } catch (error) {
      prFailure = error;
    }
  }
  await settleAttempt(outcome, prUrl, log, exec);
  if (prFailure !== undefined) {
    const reason =
      prFailure instanceof Error ? prFailure.message : String(prFailure);
    log({
      kind: "pr-open-failed",
      level: "error",
      msg: `PR opening failed after a successful Attempt: ${reason}`,
    });
    throw prFailure;
  }
  return outcome;
}

/**
 * The Worker entrypoint command's real wiring — today's collaborators,
 * composed the same way the Tick's act phase composes them for a dispatched
 * Worker (src/app/tick.ts), minus the concurrency that only a whole batch
 * needs. A ticket's title is read directly (no world snapshot here) for the
 * PR title `openPrForOutcome` wants.
 */
export async function workerAttemptOnce(
  config: WorkerAttemptConfig,
  ticket: number,
  attempt: number,
  deps: { log: Log },
): Promise<WorkerOutcome> {
  const exec = withDebugLogging(realExec, deps.log);
  const workerLog = deps.log.child({ ticket, attempt });
  return runWorkerAttempt(ticket, attempt, {
    dispatch: (t, a, onActivity) =>
      dispatchWorker(
        t,
        {
          model: modelForAttempt(config, a),
          attempt: a,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          maxCostUsd: config.maxCostUsd,
        },
        exec,
        realSpawnWorkerProcess,
        workerLog,
        onActivity,
      ),
    openPr: async (workerOutcome) => {
      const title = await readTicketTitle(workerOutcome.ticket, exec);
      return openPrForOutcome(workerOutcome, title, exec);
    },
    exec,
    log: workerLog,
  });
}
