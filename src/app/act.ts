import {
  claimTicket,
  closeTicket,
  commentConflictUnresolved,
  type Exec,
  escalateTicket,
  markPrReady,
  realExec,
  releaseFailedTicket,
  releaseTicket,
  updatePrBranch,
  voidAttempt,
} from "../adapters/tracker.js";
import { type ConflictOutcome, pushAgentBranch } from "../adapters/worker.js";
import { reclassifyCorrelatedFailures } from "../core/classify.js";
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
  dispatch: DispatchWorker,
  openPr: OpenPr,
  dispatchConflict: DispatchConflictWorker,
  exec: Exec = realExec,
  log: (line: string) => void,
): Promise<ActReport> {
  const workers: Promise<SpawnResult>[] = [];
  const conflicts: Promise<ConflictOutcome>[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "claim":
        await claimTicket(action.ticket, exec);
        log(`claimed #${action.ticket}`);
        break;
      case "release":
        await releaseTicket(action.ticket, action.assignees, exec);
        log(`released #${action.ticket} (orphaned claim)`);
        break;
      case "escalate":
        await escalateTicket(action.ticket, action.failures, exec);
        log(
          `escalated #${action.ticket} to ready-for-human (attempts exhausted)`,
        );
        break;
      case "close":
        await closeTicket(action.ticket, action.prUrl, exec);
        log(`closed #${action.ticket} (merged: ${action.prUrl})`);
        break;
      case "update-branch":
        await updatePrBranch(action.pr, exec);
        log(
          `updated PR #${action.pr} branch (mechanical rebase onto the base)`,
        );
        break;
      case "mark-ready":
        await markPrReady(action.pr, exec);
        log(`marked PR #${action.pr} ready for review`);
        break;
      case "conflict-worker":
        conflicts.push(
          dispatchConflict(action.pr, action.ticket, action.headRef),
        );
        log(
          `dispatched conflict Worker for PR #${action.pr} (ticket #${action.ticket})`,
        );
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
        log(`spawned Worker for #${action.ticket} (attempt ${action.attempt})`);
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
    log(describeOutcome(outcome));
    if (prUrl !== undefined)
      log(`opened draft PR for #${outcome.ticket}: ${prUrl}`);
    if (outcome.costOverrun && outcome.costUsd !== undefined) {
      log(
        `cost overrun on #${outcome.ticket}: attempt ${outcome.attempt} spent $${outcome.costUsd.toFixed(2)} — the ticket may be cut too big for one Worker`,
      );
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
      log(
        `voided attempt ${outcome.attempt} of #${outcome.ticket} (${outcome.infra}); claim held`,
      );
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
      log(
        `released #${outcome.ticket} with the attempt record (failed attempt ${outcome.attempt})`,
      );
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
    log(describeConflict(outcome));
    if (outcome.resolved) {
      await pushAgentBranch(outcome.headRef, exec);
      log(`pushed the resolved rebase for PR #${outcome.pr}`);
    } else {
      await commentConflictUnresolved(outcome.pr, exec);
      log(`asked for human resolution on PR #${outcome.pr}`);
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
