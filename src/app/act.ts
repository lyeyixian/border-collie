import {
  claimTicket,
  closeTicket,
  commentConflictUnresolved,
  type Exec,
  escalateTicket,
  markPrReady,
  releaseFailedTicket,
  releaseTicket,
  updatePrBranch,
  voidAttempt,
} from "../adapters/tracker.js";
import { type ConflictOutcome, pushAgentBranch } from "../adapters/worker.js";
import { reclassifyCorrelatedFailures } from "../core/classify.js";
import type { Log } from "../core/log.js";
import type { Action, WorkerOutcome } from "../core/types.js";

/**
 * Dispatch one Worker against one claimed ticket; the caller binds the
 * attempt number to a model (the retry ladder).
 */
export type DispatchWorker = (
  ticket: number,
  attempt: number,
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
}

function describeOutcome(outcome: WorkerOutcome): string {
  const commits = `${outcome.newCommits} new commit${outcome.newCommits === 1 ? "" : "s"}`;
  const where = `on ${outcome.branch} (transcript: ${outcome.transcript})`;
  if (outcome.ok)
    return `Worker for #${outcome.ticket} succeeded: ${commits} ${where}`;
  if (outcome.infra !== undefined) {
    return `Worker for #${outcome.ticket} hit an infrastructure failure (${outcome.infra}): attempt ${outcome.attempt} voided, exit ${outcome.exitCode} ${where}`;
  }
  return `Worker for #${outcome.ticket} failed attempt ${outcome.attempt} (${outcome.failure}): exit ${outcome.exitCode}, ${commits} ${where}`;
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
}

function describeConflict(outcome: ConflictOutcome): string {
  const where = `on ${outcome.headRef} (transcript: ${outcome.transcript})`;
  return outcome.resolved
    ? `Conflict Worker for PR #${outcome.pr} resolved the conflicts ${where}`
    : `Conflict Worker for PR #${outcome.pr} could not resolve the conflicts (exit ${outcome.exitCode}) ${where}`;
}

/**
 * Act phase: perform the planned writes in plan order (releases first), one
 * at a time, narrating each as it lands. Spawns are the exception: each
 * Worker starts as its action is reached but runs concurrently, its branch
 * becoming a draft PR the moment it succeeds, and the Tick waits for all of
 * them before reporting outcomes. A failed attempt is then released with its
 * forensic record — the write that makes attempt history live on the
 * tracker, where the next Tick's retry ladder and a later Escalation read it
 * back. An infrastructure-classified failure is voided instead: a comment
 * that uncounts the claim while keeping it held, so an outage burns no
 * Attempts — and the same-way-same-Tick heuristic reclassifies correlated
 * deaths once every Worker has settled. The report's infra count is what
 * trips the caller's circuit breaker. A tracker failure mid-way throws — the
 * stateless recovery story is re-running the Tick, which recomputes the
 * world and re-plans whatever is still due. PR upkeep runs alongside dispatch:
 * the mechanical branch update and draft→ready flip are immediate tracker
 * writes; a conflict Worker runs concurrently like a spawn, its resolved
 * rebase pushed (or the PR handed to a human) once it settles.
 */
export async function act(
  actions: Action[],
  deps: ActDeps,
): Promise<ActReport> {
  const { dispatch, openPr, dispatchConflict, exec, log } = deps;
  const workers: Promise<SpawnResult>[] = [];
  const conflicts: Promise<ConflictOutcome>[] = [];
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
        await releaseTicket(action.ticket, action.assignees, exec);
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
      case "conflict-worker":
        conflicts.push(
          dispatchConflict(action.pr, action.ticket, action.headRef),
        );
        log({
          kind: "conflict-dispatch",
          level: "info",
          msg: `dispatched conflict Worker for PR #${action.pr} (ticket #${action.ticket})`,
          pr: action.pr,
          ticket: action.ticket,
        });
        break;
      case "spawn":
        workers.push(
          dispatch(action.ticket, action.attempt).then(
            async (outcome): Promise<SpawnResult> => {
              if (!outcome.ok) return { outcome };
              try {
                return { outcome, prUrl: await openPr(outcome) };
              } catch (error) {
                return { outcome, prFailure: error };
              }
            },
          ),
        );
        log({
          kind: "spawn",
          level: "info",
          msg: `spawned Worker for #${action.ticket} (attempt ${action.attempt})`,
          ticket: action.ticket,
          attempt: action.attempt,
        });
        break;
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
  // results so each outcome keeps its own PR.
  const outcomes = reclassifyCorrelatedFailures(
    fulfilled.map((spawn) => spawn.outcome),
  ).map((outcome, i) => ({ outcome, prUrl: fulfilled[i]?.prUrl }));
  for (const { outcome, prUrl } of outcomes) {
    log({
      kind: "worker-outcome",
      level: outcome.infra !== undefined ? "warn" : "info",
      msg: describeOutcome(outcome),
      outcome,
    });
    if (prUrl !== undefined) {
      log({
        kind: "pr-opened",
        level: "info",
        msg: `opened draft PR for #${outcome.ticket}: ${prUrl}`,
        ticket: outcome.ticket,
        prUrl,
      });
    }
    if (outcome.costOverrun && outcome.costUsd !== undefined) {
      log({
        kind: "cost-overrun",
        level: "warn",
        msg: `cost overrun on #${outcome.ticket}: attempt ${outcome.attempt} spent $${outcome.costUsd.toFixed(2)} — the ticket may be cut too big for one Worker`,
        ticket: outcome.ticket,
        attempt: outcome.attempt,
        costUsd: outcome.costUsd,
      });
    }
    if (outcome.infra !== undefined) {
      await voidAttempt(
        outcome.ticket,
        {
          attempt: outcome.attempt,
          reason: outcome.infra,
          model: outcome.model,
          transcript: outcome.transcript,
        },
        exec,
      );
      log({
        kind: "attempt-voided",
        level: "warn",
        msg: `voided attempt ${outcome.attempt} of #${outcome.ticket} (${outcome.infra}); claim held`,
        ticket: outcome.ticket,
        attempt: outcome.attempt,
        reason: outcome.infra,
      });
    } else if (outcome.failure) {
      await releaseFailedTicket(
        outcome.ticket,
        {
          attempt: outcome.attempt,
          reason: outcome.failure,
          model: outcome.model,
          branch: outcome.branch,
          transcript: outcome.transcript,
        },
        exec,
      );
      log({
        kind: "attempt-released",
        level: "info",
        msg: `released #${outcome.ticket} with the attempt record (failed attempt ${outcome.attempt})`,
        ticket: outcome.ticket,
        attempt: outcome.attempt,
        reason: outcome.failure,
      });
    }
  }
  // Conflict Workers settle alongside the dispatch Workers: a resolved merge is
  // pushed to the PR's branch, an unresolved one handed to a human with the
  // marker that vetoes a second Worker. Both writes are reported before any
  // infrastructure failure on either fleet rethrows.
  const settledConflicts = await Promise.allSettled(conflicts);
  for (const result of settledConflicts) {
    if (result.status !== "fulfilled") continue;
    const outcome = result.value;
    log({
      kind: "conflict-outcome",
      level: outcome.resolved ? "info" : "warn",
      msg: describeConflict(outcome),
      pr: outcome.pr,
      resolved: outcome.resolved,
    });
    if (outcome.resolved) {
      await pushAgentBranch(outcome.headRef, exec);
      log({
        kind: "conflict-pushed",
        level: "info",
        msg: `pushed the resolved rebase for PR #${outcome.pr}`,
        pr: outcome.pr,
      });
    } else {
      await commentConflictUnresolved(outcome.pr, exec);
      log({
        kind: "conflict-unresolved",
        level: "warn",
        msg: `asked for human resolution on PR #${outcome.pr}`,
        pr: outcome.pr,
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
      throw result.value.prFailure;
    }
  }
  return {
    infraFailures: outcomes.filter(({ outcome }) => outcome.infra !== undefined)
      .length,
  };
}
