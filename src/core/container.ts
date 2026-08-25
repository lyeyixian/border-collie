/**
 * A session container's identity (issue #177): the repository, Ticket and
 * Attempt it was started for, carried as container labels rather than
 * encoded into a single display string. This replaces the GitHub Actions
 * liveness read's own encoding (`workerRunName`/`ticketFromWorkerRunName`,
 * adapters/tracker.ts), which packs the same two numbers into a run's
 * display title and parses them back out with a regex — labels are simply a
 * better place to put it, structured rather than string-shaped. Kept pure
 * and here in core, same as that pair, so the shape is tested as plain
 * inputs and outputs with no subprocess involved.
 *
 * Also holds the pure half of keeping a session's transcript on the host
 * after its container exits (issue #182): where a repository's transcripts
 * live on disk, which file belongs to which Ticket, and which of them a
 * retention sweep may delete. The I/O — the bind mount, the directory
 * listing, the delete — is adapters/container.ts's `pruneTranscripts`.
 */

const LABEL_NAMESPACE = "sh.border-collie";

/** The label naming a session container's repository, `"owner/repo"`. */
export const REPOSITORY_LABEL = `${LABEL_NAMESPACE}.repository`;
/** The label naming a session container's Ticket (issue) number. */
export const TICKET_LABEL = `${LABEL_NAMESPACE}.ticket`;
/** The label naming a session container's Attempt number. */
export const ATTEMPT_LABEL = `${LABEL_NAMESPACE}.attempt`;

/** One session container's identity: which repository, Ticket and Attempt it runs. */
export interface SessionLabels {
  /** `"owner/repo"`, as GitHub names it. */
  repository: string;
  ticket: number;
  attempt: number;
}

/** `SessionLabels` as the `key=value` map `docker run --label` takes, one entry per field. */
export function encodeSessionLabels(
  session: SessionLabels,
): Record<string, string> {
  return {
    [REPOSITORY_LABEL]: session.repository,
    [TICKET_LABEL]: String(session.ticket),
    [ATTEMPT_LABEL]: String(session.attempt),
  };
}

/**
 * `SessionLabels` decoded back from `docker ps`'s own label listing: one
 * line per container, each a comma-joined `key=value` pairing (its
 * `--format '{{.Labels}}'` output) — the container's *entire* label set, our
 * three among whatever else Docker or an operator added. Undefined when the
 * three border-collie keys are not all present, or when the ticket or
 * attempt is not a plain non-negative integer — either means this is not a
 * border-collie session container, or its labels were tampered with, and
 * either way there is nothing here to trust.
 */
export function parseSessionLabels(
  rawLabels: string,
): SessionLabels | undefined {
  const labels = new Map<string, string>();
  for (const pair of rawLabels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    labels.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const repository = labels.get(REPOSITORY_LABEL);
  const ticketRaw = labels.get(TICKET_LABEL);
  const attemptRaw = labels.get(ATTEMPT_LABEL);
  if (
    repository === undefined ||
    repository === "" ||
    ticketRaw === undefined ||
    attemptRaw === undefined ||
    !/^\d+$/.test(ticketRaw) ||
    !/^\d+$/.test(attemptRaw)
  ) {
    return undefined;
  }
  return { repository, ticket: Number(ticketRaw), attempt: Number(attemptRaw) };
}

/**
 * Default retention window for session-container transcripts kept on the
 * host (issue #182): long enough to cover a weekend an operator did not look
 * at the fleet, short enough that a long-running host does not accumulate
 * every transcript it has ever written. `pruneTranscripts` (adapters/
 * container.ts) defaults its own retention window to this; a caller with a
 * configured window overrides it there.
 */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 14;

/** {@link DEFAULT_TRANSCRIPT_RETENTION_DAYS}, in the milliseconds `transcriptsToPrune` compares ages in. */
export const DEFAULT_TRANSCRIPT_RETENTION_MS =
  DEFAULT_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * One repository's session-container transcripts live on the host nested
 * owner then name — the same shape GitHub itself names a repository
 * (`SessionLabels.repository`, above), so two repositories can never
 * collide without a separate encoding scheme to keep in sync with it.
 * Rejects anything that is not a plain `"owner/repo"` pair, since this
 * feeds a `docker run --volume` bind-mount source and a path-traversal
 * component (`..`, a leading `/`) has no business reaching one.
 */
export function transcriptHostDir(root: string, repository: string): string {
  const parts = repository.split("/");
  const validPart = (part: string) =>
    part !== "." && part !== ".." && /^[\w.-]+$/.test(part);
  if (parts.length !== 2 || !parts.every(validPart)) {
    throw new Error(
      `repository must be "owner/repo", got ${JSON.stringify(repository)}`,
    );
  }
  return `${root.replace(/\/+$/, "")}/${parts[0]}/${parts[1]}`;
}

/** A session container's transcript or stderr file, matching `dispatchWorker`'s own naming (adapters/worker.ts, `--in-place`). */
const TRANSCRIPT_FILE_PATTERN =
  /^ticket-(\d+)-attempt-(\d+)\.(?:jsonl|stderr\.log)$/;

/**
 * The session — Ticket and Attempt — one file in a repository's transcript
 * directory belongs to, parsed from the file name `dispatchWorker` already
 * fixes. Undefined for anything else found there, so pruning only ever
 * touches a file this shape actually wrote rather than guessing at
 * unrecognised content.
 */
export function sessionFromTranscriptFileName(
  name: string,
): { ticket: number; attempt: number } | undefined {
  const match = TRANSCRIPT_FILE_PATTERN.exec(name);
  if (!match) return undefined;
  return { ticket: Number(match[1]), attempt: Number(match[2]) };
}

/**
 * A live-session set's own key, one Ticket's one Attempt — `dispatchWorker`
 * runs at most one Attempt at a time per Ticket, but a transcript directory
 * still holds every past Attempt's evidence side by side (namespaced per
 * attempt so a retry never clobbers the last one's), so pruning must not
 * collapse "this Ticket has a live Attempt" into "every file this Ticket
 * ever wrote is live" — a stale Attempt 1 must still age out while Attempt 2
 * runs. Shared between `transcriptsToPrune` below and whichever adapter
 * function builds the live set from `docker ps` labels, so both sides of the
 * comparison always agree on the key's shape.
 */
export function transcriptSessionKey(ticket: number, attempt: number): string {
  return `${ticket}:${attempt}`;
}

/** One file `pruneTranscripts` (adapters/container.ts) is deciding about: its name and last-modified time. */
export interface TranscriptFile {
  name: string;
  mtimeMs: number;
}

/**
 * File names, among one repository's transcript directory listing, that a
 * retention sweep should delete (issue #182's pruning rule): older than the
 * window, and — the acceptance criterion that overrides age — not the exact
 * session (Ticket and Attempt) a session container is still running.
 * `liveSessions` is keyed by `transcriptSessionKey`. A file whose name does
 * not parse as one `dispatchWorker` wrote is left alone rather than guessed
 * at.
 */
export function transcriptsToPrune(
  files: readonly TranscriptFile[],
  now: number,
  retentionMs: number,
  liveSessions: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => {
      const session = sessionFromTranscriptFileName(file.name);
      if (session === undefined) return false;
      if (
        liveSessions.has(transcriptSessionKey(session.ticket, session.attempt))
      ) {
        return false;
      }
      return now - file.mtimeMs > retentionMs;
    })
    .map((file) => file.name);
}
