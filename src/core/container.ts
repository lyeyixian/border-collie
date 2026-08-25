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
