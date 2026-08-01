import type {
  FailureReason,
  InfraReason,
  Ticket,
  WorkerOutcome,
} from "./types.js";

/**
 * Failure classification (CONTEXT.md "Infrastructure failure"): pure
 * functions that decide whether a dead Worker died to its ticket or to the
 * environment. Environment deaths void the Attempt and trip the circuit
 * breaker; only ticket deaths burn Attempts.
 */

/**
 * Textual signatures of each infrastructure-failure class, matched against
 * the Worker's stderr and transcript tails. Ordered: the most specific
 * classes first, so a rate-limited request that also logs a network retry
 * classifies as the rate limit that caused it.
 */
const INFRA_SIGNATURES: [InfraReason, RegExp][] = [
  [
    "usage-limit",
    /usage[ _]limit|usage_limit_reached|out of extra usage|limit reached\|\d/i,
  ],
  [
    "auth",
    /authentication_error|invalid api key|api key not found|please run \/login|oauth.{0,20}(expired|revoked|invalid)|401 unauthorized|credit balance is too low/i,
  ],
  [
    "rate-limit",
    /rate[ _-]?limit|overloaded_error|too many requests|"status"\s*:\s*429|http 429/i,
  ],
  [
    "network",
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|network error|connection (error|refused|reset|timed out)/i,
  ],
];

/**
 * The infrastructure class a failed Worker's output evidences, or undefined
 * when nothing points at the environment. Only ever consulted for Workers
 * that already failed: a successful Attempt is never voided, whatever
 * transient noise its logs carry. Callers must pass only text the
 * environment itself produced (stderr, the result event line) — never the
 * transcript body, where a ticket legitimately about rate limits or network
 * errors would match by content, not cause, and void its attempts forever.
 */
export function classifyInfrastructure(text: string): InfraReason | undefined {
  return INFRA_SIGNATURES.find(([, signature]) => signature.test(text))?.[0];
}

/**
 * The raw last result-event line of a transcript tail, or "" when none. The
 * one stdout line safe to classify against: on a failed run it carries the
 * CLI's own error text, not the Worker's prose or tool output.
 */
export function lastResultLine(tail: string): string {
  return (
    tail.split("\n").findLast((line) => line.includes('"type":"result"')) ?? ""
  );
}

/** The budget-relevant fields of the transcript's final stream-json result event. */
export interface ResultEvent {
  subtype: string | undefined;
  totalCostUsd: number | undefined;
  numTurns: number | undefined;
  durationMs: number | undefined;
}

/**
 * The last result event in a transcript tail, or undefined when none
 * survived. Tolerates the tail cutting a line's head and any non-JSON noise:
 * the transcript is subprocess output, not a trusted document.
 */
export function parseResultEvent(tail: string): ResultEvent | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of tail.split("\n")) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event)
      ) {
        const record = event as Record<string, unknown>;
        if (record.type === "result") last = record;
      }
    } catch {}
  }
  if (last === undefined) return undefined;
  return {
    subtype: typeof last.subtype === "string" ? last.subtype : undefined,
    totalCostUsd:
      typeof last.total_cost_usd === "number" ? last.total_cost_usd : undefined,
    numTurns: typeof last.num_turns === "number" ? last.num_turns : undefined,
    durationMs:
      typeof last.duration_ms === "number" ? last.duration_ms : undefined,
  };
}

/**
 * The failure reasons the correlated heuristic considers: the ways a Worker
 * dies without finishing, where an unrecognized environment outage is
 * plausible. Budget breaches and clean no-commit exits are exempt on the
 * same evidence: both are measured from a Worker that ran to completion,
 * which proves the environment was up.
 */
const CORRELATABLE: ReadonlySet<FailureReason> = new Set([
  "nonzero-exit",
  "timeout",
  "stall",
]);

/**
 * The same-way-same-Tick heuristic: two or more Workers dying with the same
 * process-level trigger in one Tick is an environment problem, so those
 * Attempts are voided as `correlated` infrastructure failures. Voiding is
 * cheap (the Attempt is simply retried after the breaker closes), so a
 * false positive costs a delay while a false negative burns Attempts across
 * the whole DAG.
 */
export function reclassifyCorrelatedFailures(
  outcomes: WorkerOutcome[],
): WorkerOutcome[] {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.failure !== undefined && CORRELATABLE.has(outcome.failure)) {
      counts.set(outcome.failure, (counts.get(outcome.failure) ?? 0) + 1);
    }
  }
  return outcomes.map((outcome) =>
    outcome.failure !== undefined && (counts.get(outcome.failure) ?? 0) >= 2
      ? { ...outcome, failure: undefined, infra: "correlated" as const }
      : outcome,
  );
}

/**
 * Same-Tick window for the correlation heuristic: timestamps this close
 * together read as one Tick's worth of coincident deaths — void markers
 * (breaker.ts's own trip collapsing) or, now that a self-reporting Worker
 * settles alone and never sees a sibling's outcome (issue #73),
 * Ticket-failure releases recomputed from the tracker below.
 */
export const CORRELATED_WINDOW_MS = 60_000;

/**
 * Group sorted timestamps into clusters: a new cluster starts whenever a
 * timestamp is more than `windowMs` past its cluster's own latest member.
 * The one clustering primitive both same-Tick heuristics share, since they
 * differ only in what counts as a trip once clustered: breaker.ts's void
 * collapsing trips on every cluster regardless of size (a single void always
 * trips), while `correlatedFailureTimestampsMs` below only trips a cluster of
 * two or more (a lone Ticket-failure release is not evidence of anything).
 */
export function clusterWithinWindow(
  sortedMs: number[],
  windowMs: number,
): number[][] {
  const clusters: number[][] = [];
  for (const ms of sortedMs) {
    const current = clusters.at(-1);
    const latest = current?.at(-1);
    if (
      current !== undefined &&
      latest !== undefined &&
      ms - latest <= windowMs
    ) {
      current.push(ms);
    } else {
      clusters.push([ms]);
    }
  }
  return clusters;
}

/**
 * `reclassifyCorrelatedFailures` above needs a batch of outcomes seen
 * together in one process, which a self-reporting Worker never has (issue
 * #73): each settles its own Attempt alone, whether locally or as its own
 * GitHub Actions job. This is the same heuristic recomputed instead from
 * `Ticket.lastFailureAtMs`/`lastFailureReason` — the tracker's own record of
 * each ticket's latest release, one pair per ticket, mirroring
 * `voidedAtMs` — across every ticket in Scope: two or more tickets whose
 * latest release still carries the same correlatable reason
 * (`CORRELATABLE`), posted within `CORRELATED_WINDOW_MS` of each other, are
 * read as one environment problem rather than a coincidence of tickets.
 * Each surviving cluster contributes its last timestamp, exactly like a void
 * marker's, for `deriveBreaker` (breaker.ts) to fold through the same trip
 * sequence a live batch would have.
 *
 * Unlike a void, a correlated release cannot be un-counted after the fact:
 * the Attempt already released and counted against the ticket's cap before
 * this Tick ever ran. Recomputing at Tick time recovers the breaker trip —
 * dispatch still pauses so the outage cannot burn further Attempts — but not
 * the Attempt itself, a known, accepted narrowing of "counts as nothing"
 * (CONTEXT.md "Infrastructure failure") that a synchronous batch no longer
 * makes possible.
 */
export function correlatedFailureTimestampsMs(tickets: Ticket[]): number[] {
  const byReason = new Map<FailureReason, number[]>();
  for (const { lastFailureAtMs, lastFailureReason } of tickets) {
    if (lastFailureAtMs === undefined || lastFailureReason === undefined) {
      continue;
    }
    if (!CORRELATABLE.has(lastFailureReason)) continue;
    const timestamps = byReason.get(lastFailureReason) ?? [];
    timestamps.push(lastFailureAtMs);
    byReason.set(lastFailureReason, timestamps);
  }
  const trips: number[] = [];
  for (const timestamps of byReason.values()) {
    timestamps.sort((a, b) => a - b);
    for (const cluster of clusterWithinWindow(
      timestamps,
      CORRELATED_WINDOW_MS,
    )) {
      if (cluster.length >= 2) trips.push(cluster.at(-1) as number);
    }
  }
  return trips.sort((a, b) => a - b);
}
