/**
 * The working-hours gate (CONTEXT.md "Working hours"): confines dispatch to
 * an off-hours window so the fleet works while the operator sleeps instead
 * of competing for the quota the operator is using interactively. A
 * timezone plus a start/end hour, resolved fresh against wall-clock time
 * each Tick — deliberately not encoded in a cron expression, so the window
 * stays readable in the operator's own timezone and portable between users.
 * Independent of the circuit breaker's dispatch pause (breaker.ts), which
 * means the environment itself is broken, not that the operator is awake.
 */
export interface WorkingHours {
  /** IANA time zone the start/end hours are read in. */
  timezone: string;
  /** Local hour of day [0,24) working hours start. */
  startHour: number;
  /** Local hour of day [0,24) working hours end. Less than startHour wraps past midnight. */
  endHour: number;
}

/** The local hour of day [0,24) at `nowMs`, read in `timezone`. */
function localHour(timezone: string, nowMs: number): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).format(new Date(nowMs));
  return Number(formatted);
}

/**
 * True when `nowMs`, read in the window's timezone, falls within the
 * configured working hours — the quota-consuming actions the gate suppresses
 * are due to pause. `undefined` means no window is configured: the gate
 * never applies, so dispatch runs at every hour.
 */
export function isWithinWorkingHours(
  workingHours: WorkingHours | undefined,
  nowMs: number,
): boolean {
  if (workingHours === undefined) return false;
  const { timezone, startHour, endHour } = workingHours;
  const hour = localHour(timezone, nowMs);
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/** True when `timezone` is a time zone name the runtime's Intl implementation recognizes. */
export function isValidTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
