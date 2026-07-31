import { describe, expect, it } from "vitest";
import {
  BREAKER_BASE_COOLDOWN_MS,
  BREAKER_MAX_COOLDOWN_MS,
  breakerCooldownMs,
  deriveBreaker,
  probeDue,
  tripBreaker,
} from "../../src/core/breaker.js";
import type { Ticket, WorldSnapshot } from "../../src/core/types.js";

function ticket(overrides: Partial<Ticket> & { number: number }): Ticket {
  return {
    title: `Ticket #${overrides.number}`,
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    blockedBy: [],
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    voidedAtMs: undefined,
    ...overrides,
  };
}

function world(tickets: Ticket[]): WorldSnapshot {
  return { tickets, openAgentPrs: [], mergedAgentPrs: [] };
}

describe("tripBreaker", () => {
  it("opens a closed breaker with one trip", () => {
    expect(tripBreaker(undefined, 1_000)).toEqual({
      openedAtMs: 1_000,
      trips: 1,
    });
  });

  it("re-trips an open breaker, restarting the cooldown and counting the trip", () => {
    const once = tripBreaker(undefined, 1_000);

    expect(tripBreaker(once, 9_000)).toEqual({ openedAtMs: 9_000, trips: 2 });
  });
});

describe("breakerCooldownMs", () => {
  it("doubles per consecutive trip from the base cooldown", () => {
    expect(breakerCooldownMs(1)).toBe(BREAKER_BASE_COOLDOWN_MS);
    expect(breakerCooldownMs(2)).toBe(BREAKER_BASE_COOLDOWN_MS * 2);
    expect(breakerCooldownMs(3)).toBe(BREAKER_BASE_COOLDOWN_MS * 4);
  });

  it("caps the backoff so a long usage-window outage is still probed hourly", () => {
    expect(breakerCooldownMs(20)).toBe(BREAKER_MAX_COOLDOWN_MS);
  });
});

describe("probeDue", () => {
  it("is not due before the cooldown elapses", () => {
    const breaker = tripBreaker(undefined, 0);

    expect(probeDue(breaker, BREAKER_BASE_COOLDOWN_MS - 1)).toBe(false);
  });

  it("is due once the cooldown elapses", () => {
    const breaker = tripBreaker(undefined, 0);

    expect(probeDue(breaker, BREAKER_BASE_COOLDOWN_MS)).toBe(true);
  });

  it("waits the doubled cooldown after a re-trip", () => {
    const breaker = tripBreaker(tripBreaker(undefined, 0), 1_000);

    expect(probeDue(breaker, 1_000 + BREAKER_BASE_COOLDOWN_MS)).toBe(false);
    expect(probeDue(breaker, 1_000 + 2 * BREAKER_BASE_COOLDOWN_MS)).toBe(true);
  });
});

describe("deriveBreaker", () => {
  it("stays closed when no in-Scope ticket carries a held void", () => {
    const w = world([ticket({ number: 1 }), ticket({ number: 2 })]);

    expect(deriveBreaker(w)).toBeUndefined();
  });

  it("opens from a single held void, matching one live trip", () => {
    const w = world([ticket({ number: 4, voidedAtMs: 1_000 })]);

    expect(deriveBreaker(w)).toEqual(tripBreaker(undefined, 1_000));
  });

  it("ignores a ticket whose void was superseded by a later claim or release", () => {
    const w = world([
      ticket({ number: 4, voidedAtMs: undefined }),
      ticket({ number: 5 }),
    ]);

    expect(deriveBreaker(w)).toBeUndefined();
  });

  it("collapses several tickets voided the same way in one Tick into a single trip", () => {
    // A correlated failure: three Workers die to the same outage within one
    // Tick's act phase, each voiding its own ticket a moment apart. The live
    // loop trips once per Tick regardless (CONTEXT.md "Infrastructure
    // failure" — correlated), so the derivation must match, not one trip per
    // voided ticket.
    const w = world([
      ticket({ number: 4, voidedAtMs: 1_000 }),
      ticket({ number: 7, voidedAtMs: 1_500 }),
      ticket({ number: 9, voidedAtMs: 2_000 }),
    ]);

    expect(deriveBreaker(w)).toEqual(tripBreaker(undefined, 2_000));
  });

  it("reaches the same verdict as a live process folding one trip per separate Tick", () => {
    // Three genuinely separate outage episodes, spaced well beyond both the
    // correlated-void window and the base cooldown — as distinct Ticks that
    // each independently re-tripped the breaker would be.
    const w = world([
      ticket({ number: 4, voidedAtMs: 5 * BREAKER_BASE_COOLDOWN_MS }),
      ticket({ number: 7, voidedAtMs: 1 * BREAKER_BASE_COOLDOWN_MS }),
      ticket({ number: 9, voidedAtMs: 9 * BREAKER_BASE_COOLDOWN_MS }),
    ]);

    const live = tripBreaker(
      tripBreaker(
        tripBreaker(undefined, 1 * BREAKER_BASE_COOLDOWN_MS),
        5 * BREAKER_BASE_COOLDOWN_MS,
      ),
      9 * BREAKER_BASE_COOLDOWN_MS,
    );
    expect(deriveBreaker(w)).toEqual(live);
    expect(deriveBreaker(w)).toEqual({
      openedAtMs: 9 * BREAKER_BASE_COOLDOWN_MS,
      trips: 3,
    });
  });

  it("a fresh process reaches the same paused verdict as one that watched the void happen", () => {
    const w = world([ticket({ number: 4, voidedAtMs: 0 })]);

    expect(deriveBreaker(w)).toEqual({ openedAtMs: 0, trips: 1 });
    expect(
      probeDue({ openedAtMs: 0, trips: 1 }, BREAKER_BASE_COOLDOWN_MS - 1),
    ).toBe(false);
    expect(
      probeDue({ openedAtMs: 0, trips: 1 }, BREAKER_BASE_COOLDOWN_MS),
    ).toBe(true);
  });
});
