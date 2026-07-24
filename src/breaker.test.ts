import { describe, expect, it } from "vitest";
import {
  BREAKER_BASE_COOLDOWN_MS,
  BREAKER_MAX_COOLDOWN_MS,
  breakerCooldownMs,
  probeDue,
  tripBreaker,
} from "./breaker.js";

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
