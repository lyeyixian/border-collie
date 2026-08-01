import {
  CORRELATED_WINDOW_MS,
  clusterWithinWindow,
  correlatedFailureTimestampsMs,
} from "./classify.js";
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
 * Timestamps this close together are read as one Tick's worth: the live loop
 * trips once per Tick no matter how many Workers died the same way
 * (CONTEXT.md "Infrastructure failure" — correlated), and every void comment
 * for one Tick posts back-to-back right after its Workers settle. Ticks
 * themselves are always spaced by at least the base cooldown once the
 * breaker is open, so this window can't merge two genuinely separate trips.
 * Every cluster becomes one trip regardless of size — unlike
 * `correlatedFailureTimestampsMs` below, a single held void always trips: it
 * is not a coincidence heuristic, the Worker already evidenced the
 * environment cause itself.
 */
function collapseWithinWindow(msSorted: number[]): number[] {
  return clusterWithinWindow(msSorted, CORRELATED_WINDOW_MS).map(
    (cluster) => cluster.at(-1) as number,
  );
}

/**
 * Derive the breaker fresh from the world snapshot: every in-Scope ticket's
 * still-held void marker (`Ticket.voidedAtMs`, undefined once a later claim
 * or release resolves it) contributes its timestamp, alongside every
 * correlated Ticket-failure timestamp `correlatedFailureTimestampsMs`
 * recomputes from the tracker (issue #73 — a self-reporting Worker never
 * sees a sibling's outcome to batch against, so this replaces the batch the
 * act phase used to reclassify inline). The merged timestamps collapse
 * within `CORRELATED_WINDOW_MS` of each other to the one Tick that produced
 * them, and each surviving timestamp is one trip, folded through
 * `tripBreaker` in chronological order — the same sequence a live process
 * would have applied as each Tick's infrastructure failures landed. A fresh
 * process therefore reaches the same verdict as one that watched them
 * happen, with no store beyond the tracker's own comments.
 */
export function deriveBreaker(world: WorldSnapshot): Breaker {
  const voidTimestampsMs = world.tickets
    .map((ticket) => ticket.voidedAtMs)
    .filter((ms): ms is number => ms !== undefined);
  const correlatedTimestampsMs = correlatedFailureTimestampsMs(world.tickets);
  const tripTimestampsMs = collapseWithinWindow(
    [...voidTimestampsMs, ...correlatedTimestampsMs].sort((a, b) => a - b),
  );

  return tripTimestampsMs.reduce<Breaker>(
    (breaker, ms) => tripBreaker(breaker, ms),
    undefined,
  );
}
