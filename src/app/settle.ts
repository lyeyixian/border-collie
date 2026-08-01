import { type ReadFile, realReadFile } from "../adapters/pr.js";
import {
  type Exec,
  releaseFailedTicket,
  voidAttempt,
} from "../adapters/tracker.js";
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
 * and needs the same write — today the act phase, once every Worker in a
 * Tick has settled and correlated failures are reclassified; later a Worker
 * settling its own Attempt in its own process (issue #71).
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
