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

/** One candidate verify command the Onboarding Worker looked at but did not declare. */
export interface DeclareExclusion {
  name: string;
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
    typeof (value as Partial<DeclareExclusion>).reason === "string"
  );
}

/**
 * Parse the sidecar's JSON text into a `DeclareSidecar`. Throws
 * `DeclareSidecarError`, naming the file, on anything that is not the
 * documented shape — an object with an `excluded` array of `{name, reason}`
 * entries — rather than silently dropping malformed entries, the same
 * named-error-over-silent-gap choice `parseContract` makes.
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
      `${DECLARE_SIDECAR_FILE} must be an object with an "excluded" array of {name, reason} entries`,
    );
  }
  return { excluded };
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
  /** `WORKFLOW.md` as the session left it — `EMPTY_CONTRACT` if it wrote none. */
  contract: Contract;
  excluded: DeclareExclusion[];
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

/**
 * `declare`'s report: what it produced (the acceptance criterion). Every
 * declared command by name, every excluded candidate and why, and — since
 * this rung gates on nothing — a warning line only when the session itself
 * did not run to a clean, budget-respecting completion. The warning leads
 * when the session did not finish cleanly, since the contract and
 * exclusions below it may then be stale leftovers rather than this run's
 * own output.
 */
export function renderDeclareReport(outcome: DeclareOutcome): string {
  const lines: string[] = [];
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
  if (outcome.costOverrun && outcome.costUsd !== undefined) {
    lines.push(
      "",
      "Warning:",
      `  spend $${outcome.costUsd.toFixed(2)} exceeded the cost cap`,
    );
  }
  return lines.join("\n");
}
