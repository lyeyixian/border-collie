import {
  claimTicket,
  closeTicket,
  commentConflictUnresolved,
  type Exec,
  escalateTicket,
  markPrReady,
  releaseTicket,
  updatePrBranch,
} from "../adapters/tracker.js";
import { type ConflictOutcome, pushAgentBranch } from "../adapters/worker.js";
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
 * Dispatch one Worker against one claimed ticket; the caller binds the
 * attempt number to a model (the retry ladder). `onActivity` is called
 * whenever the Worker process produces output — the fleet heartbeat's
 * activity signal, riding the process adapter's existing observation.
 */
export type DispatchWorker = (
  ticket: number,
  attempt: number,
  onActivity: () => void,
) => Promise<WorkerOutcome>;

/** Open the draft PR for a successful Attempt; resolves with the PR URL. */
export type OpenPr = (outcome: WorkerOutcome) => Promise<string>;

/** Dispatch one conflict-resolution Worker against one conflicted agent PR. */
export type DispatchConflictWorker = (
  pr: number,
  ticket: number,
  headRef: string,
) => Promise<ConflictOutcome>;

/** What one spawn action came to: the Attempt, and its PR when one was opened. */
interface SpawnResult {
  outcome: WorkerOutcome;
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

/**
 * Act phase: perform the planned writes in plan order (releases first), one
 * at a time, narrating each as it lands. Spawns are the exception: each
 * Worker starts as its action is reached but runs concurrently, its branch
 * becoming a draft PR the moment it succeeds, and the Tick waits for all of
 * them before reporting outcomes. The same-way-same-Tick heuristic
 * reclassifies correlated deaths once every Worker has settled, then each
 * outcome's write — the forensic release for a Ticket failure, the void for
 * an Infrastructure failure — is delegated to `settleAttempt`, the unit a
 * Worker settling its own Attempt will one day share. The report's infra
 * count is what trips the caller's circuit breaker. A tracker failure
 * mid-way throws — the stateless recovery story is re-running the Tick,
 * which recomputes the world and re-plans whatever is still due. PR upkeep
 * runs alongside dispatch: the mechanical branch update and draft→ready flip
 * are immediate tracker writes; a conflict Worker runs concurrently like a
 * spawn, its resolved rebase pushed (or the PR handed to a human) once it
 * settles. While any dispatch Worker is in flight, a fleet heartbeat reports
 * all of them once a minute — elapsed time and time since last output,
 * independently — and stops the moment the last one settles.
 */
export async function act(
  actions: Action[],
  deps: ActDeps,
): Promise<ActReport> {
  const {
    dispatch,
    openPr,
    dispatchConflict,
    exec,
    log,
    now,
    scheduleInterval,
  } = deps;
  const workers: Promise<SpawnResult>[] = [];
  const conflicts: Promise<ConflictSpawnResult>[] = [];
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
  // Reclassify once every Worker has settled: only the full Tick's outcomes
  // can show several Workers dying the same way (an environment problem,
  // not a coincidence of tickets). Zipped straight back onto the spawn
  // results so each outcome keeps its own PR and sub-logger.
  const reclassifiedOutcomes = reclassifyCorrelatedFailures(
    fulfilled.map((spawn) => spawn.outcome),
  );
  const outcomes = fulfilled.map((spawn, i) => ({
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

  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  const rejectedConflict = settledConflicts.find(
    (result) => result.status === "rejected",
  );
  if (rejectedConflict) throw rejectedConflict.reason;
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
