import { type Exec, realExec, withDebugLogging } from "../adapters/tracker.js";
import {
  dispatchRefinementWorker,
  type RefinementOutcome,
  realSpawnWorkerProcess,
} from "../adapters/worker.js";
import type { WorkerAttemptConfig } from "../core/config.js";
import type { Log } from "../core/log.js";
import type { SyncDispatchRefinementWorker } from "./act.js";
import { settleRefinementOutcome } from "./settle.js";

/**
 * A Refinement round settling its own outcome (issue #181): the same
 * `settleRefinementOutcome` unit the act phase's batch settles a synchronous
 * round through (src/app/act.ts), injectable so a fake dispatch/exec
 * exercises this unit without a real session.
 */
export interface RefinementWorkerDeps {
  dispatch: SyncDispatchRefinementWorker;
  exec: Exec;
  log: Log;
}

/**
 * Run one Refinement round against one open agent PR, then settle it: the
 * branch pushed back only when the round actually committed a fix — through
 * `settleRefinementOutcome` (src/app/settle.ts), the same unit the act
 * phase's batch settles a synchronous dispatch through once it finishes.
 * Unlike the act phase this has no fleet heartbeat and no concurrent
 * siblings to correlate against. The round marker itself
 * (`REFINEMENT_ROUND_MARKER`) is not posted here — the Tick that dispatched
 * this round already posted it before dispatch, the charge-before-spend
 * shape `core/types.ts` documents, unconditionally on which way dispatch
 * resolves.
 */
export async function runRefinementWorker(
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
  deps: RefinementWorkerDeps,
): Promise<RefinementOutcome> {
  const { dispatch, exec, log } = deps;
  const outcome = await dispatch(pr, ticket, headRef, round);
  await settleRefinementOutcome(outcome, log, exec);
  return outcome;
}

/**
 * The `refine` entrypoint command's real wiring — today's collaborators,
 * composed the same way `conflictWorkerOnce` composes them (src/app/
 * conflict-worker.ts, issue #181). `inPlace` forwards into the dispatched
 * Worker's config: true for a Refinement round's own session container,
 * false (the default) for the local path's worktree isolation.
 */
export async function refinementWorkerOnce(
  config: WorkerAttemptConfig,
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
  inPlace: boolean,
  deps: { log: Log },
): Promise<RefinementOutcome> {
  const exec = withDebugLogging(realExec, deps.log);
  const refinementLog = deps.log.child({ pr });
  return runRefinementWorker(pr, ticket, headRef, round, {
    dispatch: (p, t, h, r) =>
      dispatchRefinementWorker(
        p,
        t,
        h,
        r,
        {
          model: config.model,
          timeoutMs: config.timeoutMinutes * 60_000,
          stallMs: config.stallMinutes * 60_000,
          maxTurns: config.maxTurns,
          inPlace,
        },
        exec,
        realSpawnWorkerProcess,
        refinementLog,
      ),
    exec,
    log: refinementLog,
  });
}
