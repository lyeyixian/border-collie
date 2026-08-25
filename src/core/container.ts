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
 * A Docker-safe slug for `repository` ("owner/repo"), naming the
 * intermediate images `resolveSessionImage` (adapters/container.ts) builds
 * for one repository (issue #180). Docker image names must be lowercase, so
 * this lowercases; every run of characters outside `[a-z0-9._-]` (a `/`
 * included) collapses to a single `-` so an unusual repository name still
 * yields one valid tag component rather than an invalid reference.
 */
export function repositoryImageSlug(repository: string): string {
  return repository
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Border-collie's own layer, built on top of whatever a repository's own
 * Dockerfile produced (issue #180): `${REPO_IMAGE}` is a build arg, filled
 * in by `resolveSessionImage` (adapters/container.ts) with the repository's
 * own image tag, never the repository's own file — this is border-collie's
 * file, so the repository's Dockerfile never has to `FROM` a border-collie
 * image or install border-collie's own tools itself (ADR 0009: "must never
 * be required to start from a border-collie base image"). `version` pins
 * this daemon's own install of border-collie, the same discipline
 * `pinCliVersion` (core/scaffold.ts) gives the Actions workflow templates.
 *
 * Assumes a Debian-or-Ubuntu-family repository image (`apt-get`, `dpkg`) —
 * a documented limit rather than a silently narrower promise than the rest
 * of this ticket, the same way ADR 0009 states its own limitations plainly
 * rather than leaving them to be discovered. A repository whose Dockerfile
 * produces a non-Debian image needs a different layer than this one; that
 * is out of scope here.
 */
export function sessionLayerDockerfile(version: string): string {
  return [
    "ARG REPO_IMAGE",
    // Built rather than written as the literal "FROM ${REPO_IMAGE}": that
    // reads as a forgotten JS template placeholder, though it is Docker's
    // own ARG substitution syntax.
    `FROM ${"$"}{REPO_IMAGE}`,
    "",
    "RUN apt-get update \\",
    " && apt-get install -y --no-install-recommends curl git ca-certificates gnupg \\",
    " && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \\",
    " && apt-get install -y --no-install-recommends nodejs \\",
    " && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \\",
    " && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \\",
    ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\',
    " && apt-get update \\",
    " && apt-get install -y --no-install-recommends gh \\",
    ` && npm install -g @anthropic-ai/claude-code@latest border-collie@${version} \\`,
    " && rm -rf /var/lib/apt/lists/*",
    "",
  ].join("\n");
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

/**
 * PR-scoped session identity (issue #181): a Conflict Worker or a Refinement
 * round, neither of which is an Attempt and neither of which has a ticket
 * plus attempt number to key on — a PR is the handle both work against, so
 * `kind` is what tells the two apart on the same label set rather than
 * `ticket`/`attempt`, which `SessionLabels` above keeps for the Worker
 * Attempt it is shaped for.
 */
export type PrSessionKind = "conflict" | "refinement";

/** The label naming a PR session container's pull request number. */
export const PR_LABEL = `${LABEL_NAMESPACE}.pr`;
/** The label naming a PR session container's kind: a Conflict Worker or a Refinement round. */
export const KIND_LABEL = `${LABEL_NAMESPACE}.kind`;

/** One PR-scoped session container's identity: which repository, pull request and kind it runs. */
export interface PrSessionLabels {
  repository: string;
  pr: number;
  kind: PrSessionKind;
}

/** `PrSessionLabels` as the `key=value` map `docker run --label` takes, one entry per field. */
export function encodePrSessionLabels(
  session: PrSessionLabels,
): Record<string, string> {
  return {
    [REPOSITORY_LABEL]: session.repository,
    [PR_LABEL]: String(session.pr),
    [KIND_LABEL]: session.kind,
  };
}

/**
 * `PrSessionLabels` decoded back from `docker ps`'s own label listing, the
 * PR-scoped mirror of `parseSessionLabels` above — same undefined-on-anything
 * untrustworthy contract: a missing label, a `pr` that is not a plain
 * non-negative integer, or a `kind` that is neither `"conflict"` nor
 * `"refinement"` all mean this is not a border-collie PR session container.
 */
export function parsePrSessionLabels(
  rawLabels: string,
): PrSessionLabels | undefined {
  const labels = new Map<string, string>();
  for (const pair of rawLabels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    labels.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const repository = labels.get(REPOSITORY_LABEL);
  const prRaw = labels.get(PR_LABEL);
  const kind = labels.get(KIND_LABEL);
  if (
    repository === undefined ||
    repository === "" ||
    prRaw === undefined ||
    !/^\d+$/.test(prRaw) ||
    (kind !== "conflict" && kind !== "refinement")
  ) {
    return undefined;
  }
  return { repository, pr: Number(prRaw), kind };
}
