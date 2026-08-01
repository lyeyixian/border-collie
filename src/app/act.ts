import {
  claimTicket,
  closeTicket,
  commentConflictUnresolved,
  type Exec,
  escalateTicket,
  giveUpOnPr,
  markPrReady,
  releaseTicket,
  startRefinementRound,
  updatePrBranch,
} from "../adapters/tracker.js";
import {
  type ConflictOutcome,
  pushAgentBranch,
  type RefinementOutcome,
} from "../adapters/worker.js";
import { reclassifyCorrelatedFailures } from "../core/classify.js";
import { heartbeatSnapshot, type WorkerActivity } from "../core/heartbeat.js";
import type { Log } from "../core/log.js";
import { renderHeartbeat } from "../core/render.js";
import type { Action, WorkerOutcome } from "../core/types.js";
import { settleAttempt } from "./settle.js";

/** How often the fleet heartbeat reports, while any Worker is in flight. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Starts a recurring callback every `ms`; returns a function that cancels
 * it. The run loop's existing treatment of time (an injected clock plus an
 * injected waiter) extended with the one new primitive the heartbeat needs:
 * something to cancel immediately once the last Worker settles, rather than
 * waiting out a pending wait.
 */
export type IntervalScheduler = (
  ms: number,
  callback: () => void,
) => () => void;

/**
 * A dispatch that waits for the Worker to finish and resolves with its
 * outcome — what the local, synchronous path (`dispatchWorker`,
 * adapters/worker.ts) always is, and the only kind the Worker entrypoint's
 * own dispatch call can sensibly be (src/app/worker.ts, issue #71): it runs
 * the session itself, so firing-and-forgetting from its own perspective
 * would make no sense. A stricter return type than `DispatchWorker` below,
 * and so always assignable to it.
 */
export type SyncDispatchWorker = (
  ticket: number,
  attempt: number,
  onActivity: () => void,
) => Promise<WorkerOutcome>;

/**
 * Dispatch one Worker against one claimed ticket; the caller binds the
 * attempt number to a model (the retry ladder). `onActivity` is called
 * whenever the Worker process produces output — the fleet heartbeat's
 * activity signal, riding the process adapter's existing observation.
 *
 * Two implementations share this seam (issue #73). The local one
 * (`dispatchWorker`) runs the Worker to completion and always resolves with
 * its outcome — a `SyncDispatchWorker`. The remote one (`dispatchRemoteWorker`,
 * adapters/worker.ts) triggers the Worker's GitHub Actions job and resolves
 * immediately with `undefined`: no outcome to settle here, because the job
 * runs the Worker entrypoint that settles its own Attempt (src/app/worker.ts)
 * and the next Tick reads the result back from the tracker. `act` below
 * therefore completes without waiting for a Worker dispatched this way —
 * there is nothing left for it to await.
 */
export type DispatchWorker = (
  ticket: number,
  attempt: number,
  onActivity: () => void,
) => Promise<WorkerOutcome | undefined>;

/** Open the draft PR for a successful Attempt; resolves with the PR URL. */
export type OpenPr = (outcome: WorkerOutcome) => Promise<string>;

/** Dispatch one conflict-resolution Worker against one conflicted agent PR. */
export type DispatchConflictWorker = (
  pr: number,
  ticket: number,
  headRef: string,
) => Promise<ConflictOutcome>;

/** Dispatch one Refinement-round Worker against one open agent PR. */
export type DispatchRefinementWorker = (
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
) => Promise<RefinementOutcome>;

/**
 * What one spawn action came to: the Attempt, and its PR when one was
 * opened. `outcome` is undefined when the dispatch was fire-and-forget (the
 * remote implementation) — the Worker settles its own Attempt elsewhere, so
 * there is nothing here to reclassify or settle.
 */
interface SpawnResult {
  outcome: WorkerOutcome | undefined;
  prUrl?: string;
  /** PR opening failed after a successful Attempt; reported, then rethrown. */
  prFailure?: unknown;
  /** This Worker's sub-logger, carried forward so outcome/PR lines inherit its bindings. */
  log: Log;
}

/** What one conflict-worker action came to: the outcome, and its sub-logger to carry forward. */
interface ConflictSpawnResult {
  outcome: ConflictOutcome;
  log: Log;
}

/** What one refine-pr action came to: the outcome, and its sub-logger to carry forward. */
interface RefinementSpawnResult {
  outcome: RefinementOutcome;
  log: Log;
}

/** What one Tick's act phase reports back to the loop. */
export interface ActReport {
  /** Infrastructure-voided Attempts this Tick — any at all trips the circuit breaker. */
  infraFailures: number;
}

/** The act phase's effects, injectable for tests, matching the run loop's pattern. */
export interface ActDeps {
  dispatch: DispatchWorker;
  openPr: OpenPr;
  dispatchConflict: DispatchConflictWorker;
  dispatchRefinement: DispatchRefinementWorker;
  exec: Exec;
  log: Log;
  /** The heartbeat's clock, following the run loop's existing treatment of time. */
  now: () => number;
  /** The heartbeat's scheduler, following the run loop's existing treatment of time. */
  scheduleInterval: IntervalScheduler;
}

/** One spawned Worker's handle onto the fleet heartbeat: touch on activity, stop once settled. */
interface HeartbeatHandle {
  touch: () => void;
  stop: () => void;
}

/**
 * Tracks every in-flight dispatch Worker's activity and reports the fleet
 * heartbeat once a minute, starting the scheduler on the first Worker and
 * cancelling it the moment the last one settles. Kept apart from the
 * action-dispatch switch below, which only calls `start`/`touch`/`stop` —
 * the heartbeat's own lifecycle is a separate concern from performing one
 * planned write.
 */
function createHeartbeat(
  now: () => number,
  scheduleInterval: IntervalScheduler,
  log: Log,
): { start: (ticket: number, attempt: number) => HeartbeatHandle } {
  const activity = new Map<string, WorkerActivity>();
  let stopScheduler: (() => void) | undefined;

  function stopIfIdle(): void {
    if (activity.size === 0 && stopScheduler !== undefined) {
      stopScheduler();
      stopScheduler = undefined;
    }
  }

  return {
    start(ticket, attempt) {
      const key = `${ticket}:${attempt}`;
      const startedAtMs = now();
      activity.set(key, {
        ticket,
        attempt,
        startedAtMs,
        lastActivityAtMs: startedAtMs,
      });
      if (stopScheduler === undefined) {
        stopScheduler = scheduleInterval(HEARTBEAT_INTERVAL_MS, () => {
          if (activity.size === 0) return;
          const heartbeats = heartbeatSnapshot([...activity.values()], now());
          log({
            kind: "heartbeat",
            level: "info",
            msg: renderHeartbeat(heartbeats),
            workers: heartbeats,
          });
        });
      }
      return {
        touch: () => {
          const entry = activity.get(key);
          if (entry) entry.lastActivityAtMs = now();
        },
        stop: () => {
          activity.delete(key);
          stopIfIdle();
        },
      };
    },
  };
}

function describeConflict(outcome: ConflictOutcome): string {
  const where = `on ${outcome.headRef} (transcript: ${outcome.transcript})`;
  return outcome.resolved
    ? `Conflict Worker resolved the conflicts ${where}`
    : `Conflict Worker could not resolve the conflicts (exit ${outcome.exitCode}) ${where}`;
}

function describeRefinement(outcome: RefinementOutcome): string {
  const commits = `${outcome.newCommits} new commit${outcome.newCommits === 1 ? "" : "s"}`;
  const where = `on ${outcome.headRef} (transcript: ${outcome.transcript})`;
  return `Refinement Worker finished: ${commits} ${where}`;
}

/**
 * Act phase: perform the planned writes in plan order (releases first), one
 * at a time, narrating each as it lands. Spawns are the exception: each
 * Worker starts as its action is reached but runs concurrently, its branch
 * becoming a draft PR the moment it succeeds, and the Tick waits for
 * whichever of them the injected `dispatch` actually hands back an outcome
 * for before reporting. The local, synchronous dispatch hands back every
 * outcome, so this is unchanged for it: the same-way-same-Tick heuristic
 * reclassifies correlated deaths once every Worker has settled, then each
 * outcome's write — the forensic release for a Ticket failure, the void for
 * an Infrastructure failure — is delegated to `settleAttempt`, the unit a
 * Worker settling its own Attempt also shares (src/app/worker.ts, issue
 * #71). The remote dispatch (issue #73) hands back `undefined` instead, once
 * its Worker's GitHub Actions job is merely triggered — nothing to
 * reclassify or settle here, so this phase (and the Tick as a whole) never
 * waits for that Worker to actually finish; the job settles its own Attempt,
 * and a later Tick reads the result back from the tracker. The report's
 * infra count is what trips the caller's circuit breaker, and only ever
 * counts outcomes this Tick actually saw — a fire-and-forget dispatch's
 * eventual infra failure instead surfaces through `deriveBreaker`'s own
 * tracker read (breaker.ts) once its Worker reports. A tracker failure
 * mid-way throws — the stateless recovery story is re-running the Tick,
 * which recomputes the world and re-plans whatever is still due. PR upkeep
 * runs alongside dispatch: the mechanical branch update and draft→ready flip
 * are immediate tracker writes; a conflict Worker runs concurrently like a
 * spawn, its resolved rebase pushed (or the PR handed to a human) once it
 * settles. While any dispatch Worker is in flight, a fleet heartbeat reports
 * all of them once a minute — elapsed time and time since last output,
 * independently — and stops the moment the last one settles. A Refinement
 * round (CONTEXT.md "Refinement round") runs the same shape as a conflict
 * Worker — the round marker lands first (bounding the round even across a
 * crash), then the Worker runs concurrently, its branch pushed back only
 * when it actually committed a fix. Refinement give-up is an immediate
 * tracker write, like an escalation.
 */
export async function act(
  actions: Action[],
  deps: ActDeps,
): Promise<ActReport> {
  const {
    dispatch,
    openPr,
    dispatchConflict,
    dispatchRefinement,
    exec,
    log,
    now,
    scheduleInterval,
  } = deps;
  const workers: Promise<SpawnResult>[] = [];
  const conflicts: Promise<ConflictSpawnResult>[] = [];
  const refinements: Promise<RefinementSpawnResult>[] = [];
  const heartbeat = createHeartbeat(now, scheduleInterval, log);

  for (const action of actions) {
    switch (action.type) {
      case "claim":
        await claimTicket(action.ticket, exec);
        log({
          kind: "claim",
          level: "info",
          msg: `claimed #${action.ticket}`,
          ticket: action.ticket,
        });
        break;
      case "release":
        await releaseTicket(action.ticket, exec);
        log({
          kind: "release",
          level: "info",
          msg: `released #${action.ticket} (orphaned claim)`,
          ticket: action.ticket,
        });
        break;
      case "escalate":
        await escalateTicket(action.ticket, action.failures, exec);
        log({
          kind: "escalate",
          level: "warn",
          msg: `escalated #${action.ticket} to ready-for-human (attempts exhausted)`,
          ticket: action.ticket,
        });
        break;
      case "close":
        await closeTicket(action.ticket, action.prUrl, exec);
        log({
          kind: "close",
          level: "info",
          msg: `closed #${action.ticket} (merged: ${action.prUrl})`,
          ticket: action.ticket,
          prUrl: action.prUrl,
        });
        break;
      case "update-branch":
        await updatePrBranch(action.pr, exec);
        log({
          kind: "update-branch",
          level: "info",
          msg: `updated PR #${action.pr} branch (mechanical rebase onto the base)`,
          pr: action.pr,
        });
        break;
      case "mark-ready":
        await markPrReady(action.pr, exec);
        log({
          kind: "mark-ready",
          level: "info",
          msg: `marked PR #${action.pr} ready for review`,
          pr: action.pr,
        });
        break;
      case "conflict-worker": {
        const conflictLog = log.child({ pr: action.pr });
        conflicts.push(
          dispatchConflict(action.pr, action.ticket, action.headRef).then(
            (outcome) => ({ outcome, log: conflictLog }),
          ),
        );
        conflictLog({
          kind: "conflict-dispatch",
          level: "info",
          msg: `dispatched conflict Worker (ticket #${action.ticket})`,
          ticket: action.ticket,
        });
        break;
      }
      case "refine-pr": {
        await startRefinementRound(action.pr, action.round, exec);
        const refinementLog = log.child({ pr: action.pr });
        refinementLog({
          kind: "refinement-round-started",
          level: "info",
          msg: `started Refinement round ${action.round} for PR #${action.pr} (ticket #${action.ticket})`,
          ticket: action.ticket,
          round: action.round,
        });
        refinements.push(
          dispatchRefinement(
            action.pr,
            action.ticket,
            action.headRef,
            action.round,
          ).then((outcome) => ({ outcome, log: refinementLog })),
        );
        break;
      }
      case "refinement-give-up":
        await giveUpOnPr(action.pr, action.ticket, action.rounds, exec);
        log({
          kind: "refinement-give-up",
          level: "warn",
          msg: `gave up Refining PR #${action.pr} after ${action.rounds} rounds (ticket #${action.ticket} → ready-for-human)`,
          pr: action.pr,
          ticket: action.ticket,
          rounds: action.rounds,
        });
        break;
      case "spawn": {
        const workerLog = log.child({
          ticket: action.ticket,
          attempt: action.attempt,
        });
        const handle = heartbeat.start(action.ticket, action.attempt);
        workers.push(
          dispatch(action.ticket, action.attempt, handle.touch)
            .finally(handle.stop)
            .then(async (outcome): Promise<SpawnResult> => {
              if (outcome === undefined) {
                // Fire-and-forget: the Worker's job settles its own Attempt
                // elsewhere (src/app/worker.ts, issue #71), and the next
                // Tick reads the result back from the tracker.
                workerLog({
                  kind: "worker-dispatched-async",
                  level: "info",
                  msg: "Worker dispatched to a remote job; it will settle its own Attempt",
                });
                return { outcome: undefined, log: workerLog };
              }
              if (!outcome.ok) return { outcome, log: workerLog };
              try {
                return {
                  outcome,
                  prUrl: await openPr(outcome),
                  log: workerLog,
                };
              } catch (error) {
                return { outcome, prFailure: error, log: workerLog };
              }
            }),
        );
        workerLog({
          kind: "spawn",
          level: "info",
          msg: `spawned Worker (attempt ${action.attempt})`,
        });
        break;
      }
    }
  }

  const settled = await Promise.allSettled(workers);
  const fulfilled = settled
    .filter(
      (result): result is PromiseFulfilledResult<SpawnResult> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
  // A fire-and-forget dispatch (the remote implementation) settles nothing
  // here — its outcome is undefined, and its Attempt is settled by the
  // Worker job itself (src/app/worker.ts). Only the reportable (defined)
  // outcomes are reclassified and settled below.
  const reportable = fulfilled.filter(
    (spawn): spawn is SpawnResult & { outcome: WorkerOutcome } =>
      spawn.outcome !== undefined,
  );
  // Reclassify once every Worker has settled: only the full Tick's outcomes
  // can show several Workers dying the same way (an environment problem,
  // not a coincidence of tickets). Zipped straight back onto the spawn
  // results so each outcome keeps its own PR and sub-logger.
  const reclassifiedOutcomes = reclassifyCorrelatedFailures(
    reportable.map((spawn) => spawn.outcome),
  );
  const outcomes = reportable.map((spawn, i) => ({
    outcome: reclassifiedOutcomes[i] ?? spawn.outcome,
    prUrl: spawn.prUrl,
    log: spawn.log,
  }));
  for (const { outcome, prUrl, log: workerLog } of outcomes) {
    await settleAttempt(outcome, prUrl, workerLog, exec);
  }
  // Conflict Workers settle alongside the dispatch Workers: a resolved merge is
  // pushed to the PR's branch, an unresolved one handed to a human with the
  // marker that vetoes a second Worker. Both writes are reported before any
  // infrastructure failure on either fleet rethrows.
  const settledConflicts = await Promise.allSettled(conflicts);
  for (const result of settledConflicts) {
    if (result.status !== "fulfilled") continue;
    const { outcome, log: conflictLog } = result.value;
    conflictLog({
      kind: "conflict-outcome",
      level: outcome.resolved ? "info" : "warn",
      msg: describeConflict(outcome),
      resolved: outcome.resolved,
    });
    if (outcome.resolved) {
      await pushAgentBranch(outcome.headRef, exec);
      conflictLog({
        kind: "conflict-pushed",
        level: "info",
        msg: "pushed the resolved rebase",
      });
    } else {
      await commentConflictUnresolved(outcome.pr, exec);
      conflictLog({
        kind: "conflict-unresolved",
        level: "warn",
        msg: "asked for human resolution",
      });
    }
  }
  // Refinement-round Workers settle the same way: the branch is pushed back
  // only when the round actually committed a fix — a round that changed
  // nothing leaves the PR as it was, for the next Tick to judge afresh.
  const settledRefinements = await Promise.allSettled(refinements);
  for (const result of settledRefinements) {
    if (result.status !== "fulfilled") continue;
    const { outcome, log: refinementLog } = result.value;
    refinementLog({
      kind: "refinement-outcome",
      level: "info",
      msg: describeRefinement(outcome),
      newCommits: outcome.newCommits,
    });
    if (outcome.newCommits > 0) {
      await pushAgentBranch(outcome.headRef, exec);
      refinementLog({
        kind: "refinement-pushed",
        level: "info",
        msg: "pushed the Refinement fix",
      });
    }
  }

  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  const rejectedConflict = settledConflicts.find(
    (result) => result.status === "rejected",
  );
  if (rejectedConflict) throw rejectedConflict.reason;
  const rejectedRefinement = settledRefinements.find(
    (result) => result.status === "rejected",
  );
  if (rejectedRefinement) throw rejectedRefinement.reason;
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.prFailure !== undefined) {
      const { prFailure, log: workerLog } = result.value;
      const reason =
        prFailure instanceof Error ? prFailure.message : String(prFailure);
      workerLog({
        kind: "pr-open-failed",
        level: "error",
        msg: `PR opening failed after a successful Attempt: ${reason}`,
      });
      throw prFailure;
    }
  }
  return {
    infraFailures: outcomes.filter(({ outcome }) => outcome.infra !== undefined)
      .length,
  };
}
