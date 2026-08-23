/**
 * `declare`'s own artifacts (issue #150, CONTEXT.md "Onboarding Worker"):
 * the machine-readable sidecar an Onboarding Worker writes alongside
 * `WORKFLOW.md`, naming every candidate verify command it looked at but did
 * not declare, and why — `declare` cannot re-derive an exclusion from the
 * contract alone (an excluded command is absent from it by construction),
 * and reading the reason out of the session's own prose is exactly the kind
 * of fact-from-narrative reading the loop avoids everywhere else (never from
 * the session's own report; see classify.ts, adapters/workflow.ts).
 *
 * Sidecar parsing is a pure function over a string, the same shape as
 * `workflow.ts`'s contract parsing: JSON in, a validated shape out,
 * malformed input reported as a named error rather than silently dropped.
 */

import type { Contract } from "./workflow.js";

export class DeclareSidecarError extends Error {}

/** File name written under the fleet's local directory (`RUN_DIR`, adapters/worker.ts) — read by `declare`, then deleted. */
export const DECLARE_SIDECAR_FILE = "declare-sidecar.json";

/**
 * Why the Onboarding Worker did not declare a candidate — structural, not
 * read from its prose (ADR 0001): `"red"` is the only kind that owes a
 * tracker issue (issue #151, CONTEXT.md "Red baseline"). `"missing"` (the
 * candidate does not exist) and `"no-teardown"` (it does, but the session
 * could not clean up after running it) are not debt on a check that exists
 * and fails, so `declare` files nothing for either.
 */
export type DeclareExclusionKind = "missing" | "red" | "no-teardown";

const EXCLUSION_KINDS: readonly DeclareExclusionKind[] = [
  "missing",
  "red",
  "no-teardown",
];

/** One candidate verify command the Onboarding Worker looked at but did not declare. */
export interface DeclareExclusion {
  name: string;
  kind: DeclareExclusionKind;
  reason: string;
}

export interface DeclareSidecar {
  excluded: DeclareExclusion[];
}

/** The sidecar an absent file (every candidate qualified) resolves to. */
export const EMPTY_DECLARE_SIDECAR: DeclareSidecar = { excluded: [] };

function isExclusion(value: unknown): value is DeclareExclusion {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<DeclareExclusion>).name === "string" &&
    typeof (value as Partial<DeclareExclusion>).reason === "string" &&
    EXCLUSION_KINDS.includes(
      (value as Partial<DeclareExclusion>).kind as DeclareExclusionKind,
    )
  );
}

/**
 * Parse the sidecar's JSON text into a `DeclareSidecar`. Throws
 * `DeclareSidecarError`, naming the file, on anything that is not the
 * documented shape — an object with an `excluded` array of `{name, kind,
 * reason}` entries — rather than silently dropping malformed entries, the
 * same named-error-over-silent-gap choice `parseContract` makes.
 */
export function parseDeclareSidecar(source: string): DeclareSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new DeclareSidecarError(
      `${DECLARE_SIDECAR_FILE} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const excluded =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { excluded?: unknown }).excluded
      : undefined;
  if (!Array.isArray(excluded) || !excluded.every(isExclusion)) {
    throw new DeclareSidecarError(
      `${DECLARE_SIDECAR_FILE} must be an object with an "excluded" array of {name, kind, reason} entries, kind one of ${EXCLUSION_KINDS.join(", ")}`,
    );
  }
  return { excluded };
}

/**
 * Hidden HTML marker identifying a tracker issue as `declare`'s own
 * red-baseline record for one verify command (issue #151, CONTEXT.md "Red
 * baseline") — the same shape as the claim and release markers
 * (core/types.ts): a JSON payload between an open and close comment,
 * read back structurally rather than by title, which is fragile.
 */
const RED_BASELINE_MARKER_OPEN = "<!-- border-collie:red-baseline ";
const RED_BASELINE_MARKER_CLOSE = " -->";

export function redBaselineMarker(command: string): string {
  return `${RED_BASELINE_MARKER_OPEN}${JSON.stringify({ command })}${RED_BASELINE_MARKER_CLOSE}`;
}

/**
 * The command a red-baseline marker names, or undefined when the body
 * carries none or the marker is mangled — world input, shape-checked the
 * same as `parseAttemptMarker`.
 */
export function parseRedBaselineMarker(body: string): string | undefined {
  const start = body.indexOf(RED_BASELINE_MARKER_OPEN);
  if (start === -1) return undefined;
  const rest = body.slice(start + RED_BASELINE_MARKER_OPEN.length);
  const end = rest.indexOf(RED_BASELINE_MARKER_CLOSE);
  if (end === -1) return undefined;
  try {
    const parsed = JSON.parse(rest.slice(0, end)) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

/** One open tracker issue as `declare` needs to see it — just enough to de-duplicate by marker. */
export interface TrackerIssueRef {
  number: number;
  body: string;
}

/**
 * The open issue that already records `command` as a red baseline, if one
 * exists. Pure so the dedup rule (marker, not title) is tested without a
 * tracker (issue #151).
 */
export function findRedBaselineIssue(
  issues: TrackerIssueRef[],
  command: string,
): number | undefined {
  return issues.find((issue) => parseRedBaselineMarker(issue.body) === command)
    ?.number;
}

export function redBaselineTitle(command: string): string {
  return `red baseline: ${command}`;
}

export function redBaselineBody(exclusion: DeclareExclusion): string {
  return [
    redBaselineMarker(exclusion.name),
    `🐕 border-collie declare found \`${exclusion.name}\` red: ${exclusion.reason}. Excluded from the verify contract until it passes — see CONTEXT.md "Red baseline". This issue is not closed automatically; close it once the check is green.`,
  ].join("\n");
}

/**
 * POSIX single-quoting: wraps `value` so a shell takes it as one literal
 * argument, backticks and `$` included — unlike `JSON.stringify`, which
 * `labelCreateCommand` (core/scaffold.ts) uses for a single-line label
 * description but which would be wrong here. Double-quoting the multi-line,
 * backtick-carrying red-baseline body would both collapse its newlines to
 * the two literal characters `\`+`n` and hand a shell the backticks around
 * the command name as command substitution.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command an operator runs to file a red baseline `declare` could not
 * (issue #151) — the same hand-run degrade `labelCreateCommand`
 * (core/scaffold.ts) gives a label the tracker refused.
 */
export function redBaselineCreateCommand(exclusion: DeclareExclusion): string {
  return `gh issue create --title ${shellQuote(redBaselineTitle(exclusion.name))} --body ${shellQuote(redBaselineBody(exclusion))}`;
}

export type RedBaselineOutcome = "filed" | "already-recorded" | "failed";

/** What became of one red exclusion's tracker issue (issue #151). */
export interface RedBaselineAction {
  command: string;
  outcome: RedBaselineOutcome;
  /** The issue number, on `filed` and `already-recorded` only. */
  issue?: number;
  /** Why the tracker refused, on `failed` only. */
  error?: string;
}

/** How the Onboarding Worker's process ended — the same three outcomes every headless Worker process can end in (adapters/worker.ts's `WorkerProcessExit`). */
export type OnboardingEndedBy = "exit" | "timeout" | "stall";

/**
 * What one `declare` run came to: the session's own run facts plus what
 * `declare` read back afterwards. The one shape both `declare`'s report and
 * the app layer's return value share (mirrors `WorkerOutcome`, core/types.ts).
 */
export interface DeclareOutcome {
  endedBy: OnboardingEndedBy;
  exitCode: number | null;
  costUsd: number | undefined;
  /** Spend past the cost cap — an alarm, not a failure; this rung gates nothing. */
  costOverrun: boolean;
  /**
   * `WORKFLOW.md` as it now stands on disk: the session's own write, unless
   * `regressions` is non-empty, in which case the write was refused and this
   * is the previously declared contract instead (issue #152).
   */
  contract: Contract;
  excluded: DeclareExclusion[];
  /**
   * Previously declared commands the session found still exists but now
   * fails, naming why `declare` refused to rewrite the contract (issue
   * #152). Empty on every other run, including a repository's first.
   */
  regressions: string[];
  /** What became of each `kind: "red"` exclusion's tracker issue (issue #151) — empty when none were red. */
  redBaselines: RedBaselineAction[];
}

/**
 * Command names `previous` declared that `next` does not: a command that
 * was green and is now excluded (or simply not offered again) is a broken
 * repository, not onboarding debt — `declare` refuses to rewrite the
 * contract over one rather than letting a regression quietly shrink it
 * (issue #152, CONTEXT.md "Onboarding Worker"). Order follows `previous`'s
 * own key order, not `next`'s or the sidecar's, since `next` is exactly what
 * this function is diffing away from.
 */
export function declareRegressions(
  previous: Contract,
  next: Contract,
): string[] {
  return Object.keys(previous.verify).filter((name) => !(name in next.verify));
}

/** The one line naming why the session itself did not finish cleanly, or null when it did. */
function troubleLine(outcome: DeclareOutcome): string | null {
  if (outcome.endedBy === "timeout") {
    return "  the session hit its wall-clock timeout";
  }
  if (outcome.endedBy === "stall") {
    return "  the session produced no output and was stopped as stalled";
  }
  if (outcome.exitCode !== 0) {
    return `  the session exited with code ${outcome.exitCode}`;
  }
  return null;
}

/**
 * True when the session itself did not run to a clean completion — killed by
 * a watchdog or a non-zero exit. Distinct from `costOverrun`, which is an
 * alarm rather than a failure (a finished session's work is kept): callers
 * use this to signal failure (a non-zero process exit code), and the report
 * uses it to warn that what it read back may not be this run's own doing —
 * `WORKFLOW.md` and the sidecar are whatever the working tree already held,
 * which a session that died before writing anything leaves untouched.
 */
export function declareTroubled(outcome: DeclareOutcome): boolean {
  return troubleLine(outcome) !== null;
}

function redBaselineLine(action: RedBaselineAction): string {
  switch (action.outcome) {
    case "filed":
      return `  ${action.command} — filed as #${action.issue}`;
    case "already-recorded":
      return `  ${action.command} — already recorded as #${action.issue}`;
    case "failed":
      return `  ${action.command} — failed`;
  }
}

/**
 * The distinct refusals behind the failed filings, one indented line each and
 * in first-seen order — the same shape `failureLines` (core/scaffold.ts)
 * gives a label the tracker refused.
 */
function redBaselineFailureLines(actions: RedBaselineAction[]): string[] {
  const reasons = actions
    .filter((action) => action.outcome === "failed")
    .map((action) => action.error?.trim() || "the tracker write failed");
  return [...new Set(reasons)].flatMap((reason) =>
    reason
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => `  ${line}`),
  );
}

/**
 * True when `declare` refused to rewrite the contract over a regression.
 * Distinct from `declareTroubled`: the session itself may have run to a
 * clean completion — refusal is `declare`'s own decision, not a sign the
 * session failed.
 */
export function declareRefused(outcome: DeclareOutcome): boolean {
  return outcome.regressions.length > 0;
}

/**
 * True on either way a `declare` run needs the operator's attention: the
 * session itself did not finish cleanly, or it did and `declare` still
 * refused to rewrite the contract over a regression. The one predicate both
 * `declare` and `init` fail their own exit code on.
 */
export function declareFailed(outcome: DeclareOutcome): boolean {
  return declareTroubled(outcome) || declareRefused(outcome);
}

/**
 * `declare`'s report: what it produced (the acceptance criterion). Every
 * declared command by name, every excluded candidate and why, what became of
 * each red exclusion's tracker issue, and — since this rung gates on nothing
 * — a warning line only when the session itself did not run to a clean,
 * budget-respecting completion. The warning leads when the session did not
 * finish cleanly, since the contract and exclusions below it may then be
 * stale leftovers rather than this run's own output. A regression leads
 * ahead of even that: it names `declare`'s own refusal to rewrite the
 * contract, and the declared commands printed below it are then the
 * untouched, previously declared contract rather than anything this run
 * produced.
 */
export function renderDeclareReport(outcome: DeclareOutcome): string {
  const lines: string[] = [];
  if (outcome.regressions.length > 0) {
    lines.push(
      "Regression — WORKFLOW.md left unchanged:",
      ...outcome.regressions.map(
        (name) => `  ${name} was declared and now fails`,
      ),
      "",
    );
  }
  const trouble = troubleLine(outcome);
  if (trouble !== null) {
    lines.push(
      "Warning:",
      trouble,
      "  the contract and exclusions below may be stale — this run did not finish cleanly",
      "",
    );
  }

  const declared = Object.entries(outcome.contract.verify);
  lines.push("Declared verify contract:");
  if (declared.length === 0) {
    lines.push("  (none — no candidate command both existed and passed)");
  } else {
    for (const [name, command] of declared) {
      lines.push(`  ${name}: ${command}`);
    }
  }
  if (outcome.excluded.length > 0) {
    lines.push("", "Excluded:");
    for (const { name, reason } of outcome.excluded) {
      lines.push(`  ${name} — ${reason}`);
    }
  }
  if (outcome.redBaselines.length > 0) {
    lines.push(
      "",
      "Red baselines:",
      ...outcome.redBaselines.map(redBaselineLine),
    );
    const failed = outcome.redBaselines.filter(
      (action) => action.outcome === "failed",
    );
    if (failed.length > 0) {
      const byName = new Map(outcome.excluded.map((e) => [e.name, e]));
      lines.push(
        "",
        ...redBaselineFailureLines(failed),
        "",
        "  declare could not file these on the tracker. File them by hand:",
        ...failed
          .map((action) => byName.get(action.command))
          .filter(
            (exclusion): exclusion is DeclareExclusion =>
              exclusion !== undefined,
          )
          .map((exclusion) => `    ${redBaselineCreateCommand(exclusion)}`),
      );
    }
  }
  if (outcome.costOverrun && outcome.costUsd !== undefined) {
    lines.push(
      "",
      "Warning:",
      `  spend $${outcome.costUsd.toFixed(2)} exceeded the cost cap`,
    );
  }
  return lines.join("\n");
}
