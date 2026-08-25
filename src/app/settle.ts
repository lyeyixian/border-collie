import { type ReadFile, realReadFile } from "../adapters/pr.js";
import {
  commentConflictUnresolved,
  type Exec,
  markPrDraft,
  releaseFailedTicket,
  voidAttempt,
} from "../adapters/tracker.js";
import {
  type ConflictOutcome,
  pushAgentBranch,
  type RefinementOutcome,
} from "../adapters/worker.js";
import type { Log } from "../core/log.js";
import { buildForensicReport, renderForensicReport } from "../core/render.js";
import type { WorkerOutcome } from "../core/types.js";

function describeOutcome(outcome: WorkerOutcome): string {
  const commits = `${outcome.newCommits} new commit${outcome.newCommits === 1 ? "" : "s"}`;
  const where = `on ${outcome.branch} (transcript: ${outcome.transcript})`;
  if (outcome.ok) return `Worker succeeded: ${commits} ${where}`;
  if (outcome.infra !== undefined) {
    return `Worker hit an infrastructure failure (${outcome.infra}): attempt ${outcome.attempt} voided, exit ${outcome.exitCode} ${where}`;
  }
  return `Worker failed attempt ${outcome.attempt} (${outcome.failure}): exit ${outcome.exitCode}, ${commits} ${where}`;
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
 * Settle one finished Conflict Worker: narrate the outcome, then perform the
 * single write its shape implies — the resolved rebase pushed and the PR
 * converted to draft for a re-read before it can merge (ADR 0007), or the
 * conflict-unresolved marker asking a human to take over. Shareable by
 * anything that finishes a Conflict Worker and needs the same write — the act
 * phase, for the synchronous local dispatch, and a Conflict Worker settling
 * itself in its own session container (src/app/conflict-worker.ts, issue
 * #181).
 */
export async function settleConflictOutcome(
  outcome: ConflictOutcome,
  log: Log,
  exec: Exec,
): Promise<void> {
  log({
    kind: "conflict-outcome",
    level: outcome.resolved ? "info" : "warn",
    msg: describeConflict(outcome),
    resolved: outcome.resolved,
  });
  if (outcome.resolved) {
    await pushAgentBranch(outcome.headRef, exec);
    log({
      kind: "conflict-pushed",
      level: "info",
      msg: "pushed the resolved rebase",
    });
    // Hold the resolution back from merging until it has been looked at
    // (ADR 0007): a completed rebase says only that git finished, not that
    // the resolved code still works, and the PR may already carry an
    // approval from before the resolution existed.
    await markPrDraft(outcome.pr, exec);
    log({
      kind: "conflict-drafted",
      level: "info",
      msg: "converted the PR to draft for a re-read before it can merge",
    });
  } else {
    await commentConflictUnresolved(outcome.pr, exec);
    log({
      kind: "conflict-unresolved",
      level: "warn",
      msg: "asked for human resolution",
    });
  }
}

/**
 * Settle one finished Refinement round: narrate the outcome, then push the
 * branch back only when the round actually committed a fix — a round that
 * changed nothing leaves the PR as it was, for the next Tick to judge afresh.
 * Shareable the same way `settleConflictOutcome` is, between the act phase's
 * synchronous local dispatch and a Refinement round settling itself in its
 * own session container (src/app/refinement-worker.ts, issue #181).
 */
export async function settleRefinementOutcome(
  outcome: RefinementOutcome,
  log: Log,
  exec: Exec,
): Promise<void> {
  log({
    kind: "refinement-outcome",
    level: "info",
    msg: describeRefinement(outcome),
    newCommits: outcome.newCommits,
  });
  if (outcome.newCommits > 0) {
    await pushAgentBranch(outcome.headRef, exec);
    log({
      kind: "refinement-pushed",
      level: "info",
      msg: "pushed the Refinement fix",
    });
  }
}

/**
 * Settle one finished Attempt: narrate the outcome, then perform the single
 * tracker write its shape implies — a forensic release for a Ticket failure,
 * a void for an Infrastructure failure, neither for a success (whose only
 * write, opening the draft PR, has already happened by the time this runs;
 * `prUrl` just carries the result forward to narrate). The caller's `log`
 * carries this Attempt's ticket/attempt bindings, so every line it emits
 * stays tellable apart from a sibling Attempt settling concurrently.
 *
 * A single per-outcome unit shareable by anything that finishes an Attempt
 * and needs the same write — the act phase, once every Worker in a Tick has
 * settled and correlated failures are reclassified, and a Worker settling
 * its own Attempt in its own process (src/app/worker.ts, issue #71).
 */
export async function settleAttempt(
  outcome: WorkerOutcome,
  prUrl: string | undefined,
  log: Log,
  exec: Exec,
  readTranscript: ReadFile = realReadFile,
): Promise<void> {
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
      msg: `opened draft PR: ${prUrl}`,
      prUrl,
    });
  }
  if (outcome.costOverrun && outcome.costUsd !== undefined) {
    log({
      kind: "cost-overrun",
      level: "warn",
      msg: `cost overrun: attempt ${outcome.attempt} spent $${outcome.costUsd.toFixed(2)} — the ticket may be cut too big for one Worker`,
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
      msg: `voided attempt ${outcome.attempt} (${outcome.infra}); claim held`,
      reason: outcome.infra,
    });
  } else if (outcome.failure) {
    // Read now, while the transcript still sits on this runner's disk — a
    // later reader of the rendered comment may be on a machine where it
    // never existed. An unreadable transcript still yields the outcome's own
    // facts (see `buildForensicReport`), so this never blocks the release.
    const transcript = await readTranscript(outcome.transcript).catch(() => "");
    const forensics = renderForensicReport(
      buildForensicReport(outcome, transcript),
    );
    await releaseFailedTicket(
      outcome.ticket,
      {
        attempt: outcome.attempt,
        reason: outcome.failure,
        model: outcome.model,
        branch: outcome.branch,
        transcript: outcome.transcript,
      },
      forensics,
      exec,
    );
    log({
      kind: "attempt-released",
      level: "info",
      msg: `released with the attempt record (failed attempt ${outcome.attempt})`,
      reason: outcome.failure,
    });
  }
}
