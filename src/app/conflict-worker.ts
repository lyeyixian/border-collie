import { type Exec, realExec, withDebugLogging } from "../adapters/tracker.js";
import {
  type ConflictOutcome,
  dispatchConflictWorker,
  realSpawnWorkerProcess,
} from "../adapters/worker.js";
import type { WorkerAttemptConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import type { SyncDispatchConflictWorker } from "./act.js";
import { settleConflictOutcome } from "./settle.js";

/**
 * A Conflict Worker settling its own outcome (issue #181): the same
 * `settleConflictOutcome` unit the act phase's batch settles a synchronous
 * Conflict Worker through (src/app/act.ts), injectable so a fake
 * dispatch/exec exercises this unit without a real session.
 */
export interface ConflictWorkerDeps {
  dispatch: SyncDispatchConflictWorker;
  exec: Exec;
  log: Log;
}

/**
 * Run one Conflict Worker against one conflicted PR, then settle it: the
 * resolved rebase pushed and the PR converted to draft, or a human asked to
 * take over — through `settleConflictOutcome` (src/app/settle.ts), the same
 * unit the act phase's batch settles a synchronous dispatch through once it
 * finishes (src/app/act.ts). Unlike the act phase this has no fleet
 * heartbeat and no concurrent siblings to correlate against — both depend on
 * seeing a batch of concurrent outcomes together, which a lone Conflict
 * Worker settling itself never has.
 */
export async function runConflictWorker(
  pr: number,
  ticket: number,
  headRef: string,
  deps: ConflictWorkerDeps,
): Promise<ConflictOutcome> {
  const { dispatch, exec, log } = deps;
  const outcome = await dispatch(pr, ticket, headRef);
  await settleConflictOutcome(outcome, log, exec);
  return outcome;
}

/**
 * The `conflict-worker` entrypoint command's real wiring — today's
 * collaborators, composed the same way `workerAttemptOnce` composes them for
 * a dispatched Worker (src/app/worker.ts), minus the concurrency and
 * ticket-scoped Attempt configuration a Conflict Worker never has. `inPlace`
 * forwards into the dispatched Worker's config (issue #181): true for a
 * Conflict Worker's own session container, false (the default) for the
 * local path's worktree isolation.
 */
export async function conflictWorkerOnce(
  config: WorkerAttemptConfig,
  pr: number,
  ticket: number,
  headRef: string,
  inPlace: boolean,
  deps: { log: Log },
): Promise<ConflictOutcome> {
  const exec = withDebugLogging(realExec, deps.log);
  const conflictLog = deps.log.child({ pr });
  return runConflictWorker(pr, ticket, headRef, {
    dispatch: (p, t, h) =>
      dispatchConflictWorker(
        p,
        t,
        h,
        {
          model: config.model,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          inPlace,
        },
        exec,
        realSpawnWorkerProcess,
        conflictLog,
      ),
    exec,
    log: conflictLog,
  });
}
