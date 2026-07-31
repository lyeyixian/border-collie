import type { WorldSnapshot } from "./types.js";

/**
 * The circuit breaker (CONTEXT.md "Infrastructure failure"): pause dispatch
 * while the environment is down, resume when it recovers. Pure state
 * machine. The resident run loop still owns its own instance in memory
 * across Ticks (losing it to a crash is safe there — the next run dispatches
 * immediately and re-trips at worst one voided Attempt later). A one-Tick-
 * per-process runner has no such memory, so `deriveBreaker` below
 * reconstructs the same state fresh from the tracker every Tick instead.
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

/**
 * Derive the breaker fresh from the world snapshot: every in-Scope ticket's
 * still-held void marker (`Ticket.voidedAtMs`, undefined once a later claim
 * or release resolves it) is one trip, folded through `tripBreaker` in
 * chronological order — exactly the sequence a live process would have
 * applied as each void landed. A fresh process therefore reaches the same
 * verdict as one that watched the failures happen, with no store beyond the
 * tracker's own comments.
 */
export function deriveBreaker(world: WorldSnapshot): Breaker {
  const voidTimestampsMs = world.tickets
    .map((ticket) => ticket.voidedAtMs)
    .filter((ms): ms is number => ms !== undefined)
    .sort((a, b) => a - b);
  return voidTimestampsMs.reduce<Breaker>(
    (breaker, ms) => tripBreaker(breaker, ms),
    undefined,
  );
}
