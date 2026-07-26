/**
 * The circuit breaker (CONTEXT.md "Infrastructure failure"): pause dispatch
 * while the environment is down, resume when it recovers. Pure state
 * machine; the run loop owns the instance and the probe. Breaker state is
 * deliberately in-memory only — losing it to a crash is safe (the next run
 * dispatches immediately and re-trips at worst one voided Attempt later),
 * so it never belongs in the tracker (ADR 0001).
 */

/** Open breaker: dispatch is paused since `openedAtMs`, after `trips` consecutive trips. */
export interface OpenBreaker {
  openedAtMs: number;
  trips: number;
}

/** undefined is the closed breaker: dispatch flows normally. */
export type Breaker = OpenBreaker | undefined;

export const BREAKER_BASE_COOLDOWN_MS = 5 * 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

/**
 * Trip (or re-trip) the breaker at `nowMs`. Consecutive trips double the
 * cooldown: rate limits clear in minutes, usage windows in hours, and the
 * backoff lets one breaker wait out both without hammering probes.
 */
export function tripBreaker(breaker: Breaker, nowMs: number): OpenBreaker {
  return { openedAtMs: nowMs, trips: (breaker?.trips ?? 0) + 1 };
}

/** Cooldown before the next recovery probe: base doubled per consecutive trip, capped. */
export function breakerCooldownMs(trips: number): number {
  return Math.min(
    BREAKER_BASE_COOLDOWN_MS * 2 ** Math.max(0, trips - 1),
    BREAKER_MAX_COOLDOWN_MS,
  );
}

/** Whether the cooldown has elapsed and the environment should be probed. */
export function probeDue(breaker: OpenBreaker, nowMs: number): boolean {
  return nowMs - breaker.openedAtMs >= breakerCooldownMs(breaker.trips);
}
