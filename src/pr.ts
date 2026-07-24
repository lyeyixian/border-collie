import { readFile } from "node:fs/promises";
import { createDraftPr, type Exec, realExec } from "./tracker.js";
import {
  branchCommitSubjects,
  pushAgentBranch,
  type WorkerOutcome,
} from "./worker.js";

/**
 * PR opening: a successful Attempt's branch becomes a draft PR that closes
 * its ticket on merge. The Worker contract ends at the commit; this module is
 * the Orchestrator's half — push the branch, compose the body from the
 * Worker's final message (mechanical fallback when that fails the sanity
 * check), guarantee the close-on-merge keyword, open the draft.
 */

/** File-read half of the transcript seam, injectable for tests. */
export type ReadFile = (path: string) => Promise<string>;

const realReadFile: ReadFile = (path) => readFile(path, "utf8");

/**
 * GitHub caps issue/PR bodies at 65536 characters; a Worker body beyond this
 * margin would be rejected wholesale, so it fails the sanity check instead.
 */
export const MAX_WORKER_BODY_LENGTH = 60_000;

/**
 * The Worker's final message: the `result` payload of the last stream-json
 * result event in the transcript. Undefined unless the run ended in a clean
 * success carrying text — anything else falls back to the mechanical body.
 */
export function workerFinalMessage(transcript: string): string | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // stray non-JSON output must not sink the whole transcript
    }
    if (typeof event === "object" && event !== null && !Array.isArray(event)) {
      const record = event as Record<string, unknown>;
      if (record.type === "result") last = record;
    }
  }
  if (
    last === undefined ||
    last.subtype !== "success" ||
    last.is_error === true
  )
    return undefined;
  return typeof last.result === "string" ? last.result : undefined;
}

/**
 * The sanity check on a Worker-authored body (the acceptance criterion's
 * gate): present, not blank, within GitHub's size limit. Mechanical only — no
 * judgment about prose quality.
 */
export function isSanePrBody(body: string | undefined): body is string {
  return (
    body !== undefined &&
    body.trim() !== "" &&
    body.length <= MAX_WORKER_BODY_LENGTH
  );
}

/**
 * GitHub's close-on-merge keywords, capturing the referenced issue number.
 * Deliberately stricter than GitHub's own matcher (plain `keyword #n` only —
 * no colon, no newline between them): a miss merely appends a redundant
 * `Closes #n`, while an over-match would leave a merged PR whose ticket
 * never closes, freezing the DAG.
 */
const CLOSE_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]+#(\d+)\b/gi;

/**
 * Guarantee the body carries the close-on-merge keyword for its ticket, so a
 * merge always closes it (the DAG unfreezes on closures, not merges). Bodies
 * that already close the ticket pass through untouched.
 */
export function ensureCloseKeyword(body: string, ticket: number): string {
  for (const match of body.matchAll(CLOSE_KEYWORD)) {
    if (Number(match[1]) === ticket) return body;
  }
  return `${body.trimEnd()}\n\nCloses #${ticket}`;
}

/** Mechanical fallback body: the ticket plus the branch's commit subjects. */
export function fallbackBody(
  ticket: number,
  title: string,
  commitSubjects: string[],
): string {
  return [
    `Automated draft PR for #${ticket}: ${title}`,
    "",
    "Commits on this branch:",
    ...commitSubjects.map((subject) => `- ${subject}`),
    "",
    "(Mechanical fallback body: the Worker's final message failed the sanity check.)",
  ].join("\n");
}

/**
 * Turn a successful Attempt into a draft PR: push the agent branch, compose
 * the body, open the draft titled from the ticket. Resolves with the PR URL.
 * An unreadable transcript is a sanity-check failure, not an error — the
 * commits are the progress worth publishing either way.
 */
export async function openPrForOutcome(
  outcome: WorkerOutcome,
  ticketTitle: string,
  exec: Exec = realExec,
  read: ReadFile = realReadFile,
): Promise<string> {
  await pushAgentBranch(outcome.branch, exec);
  const finalMessage = workerFinalMessage(
    await read(outcome.transcript).catch(() => ""),
  );
  const body = isSanePrBody(finalMessage)
    ? finalMessage
    : fallbackBody(
        outcome.ticket,
        ticketTitle,
        await branchCommitSubjects(outcome.base, outcome.branch, exec),
      );
  return createDraftPr(
    {
      head: outcome.branch,
      title: ticketTitle,
      body: ensureCloseKeyword(body, outcome.ticket),
    },
    exec,
  );
}
