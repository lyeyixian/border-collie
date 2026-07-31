import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  isWithinWorkingHours,
  type WorkingHours,
} from "../../src/core/work-hours.js";

function utc(hour: number): number {
  return Date.UTC(2026, 6, 15, hour, 0, 0);
}

describe("isWithinWorkingHours", () => {
  it("is false when no window is configured", () => {
    expect(isWithinWorkingHours(undefined, utc(12))).toBe(false);
  });

  const window: WorkingHours = {
    timezone: "UTC",
    startHour: 9,
    endHour: 18,
  };

  it("is true at the start hour and false at the end hour (half-open)", () => {
    expect(isWithinWorkingHours(window, utc(9))).toBe(true);
    expect(isWithinWorkingHours(window, utc(18))).toBe(false);
  });

  it("is true in the middle of the window", () => {
    expect(isWithinWorkingHours(window, utc(13))).toBe(true);
  });

  it("is false before the window starts and after it ends", () => {
    expect(isWithinWorkingHours(window, utc(8))).toBe(false);
    expect(isWithinWorkingHours(window, utc(19))).toBe(false);
  });

  const overnight: WorkingHours = {
    timezone: "UTC",
    startHour: 22,
    endHour: 6,
  };

  it("wraps past midnight when startHour is greater than endHour", () => {
    expect(isWithinWorkingHours(overnight, utc(23))).toBe(true);
    expect(isWithinWorkingHours(overnight, utc(2))).toBe(true);
    expect(isWithinWorkingHours(overnight, utc(12))).toBe(false);
    expect(isWithinWorkingHours(overnight, utc(6))).toBe(false);
    expect(isWithinWorkingHours(overnight, utc(22))).toBe(true);
  });

  it("reads the hour in the configured timezone, not the system's", () => {
    // 09:00 UTC is 18:00 in Tokyo (UTC+9) — outside a 9-18 Tokyo window.
    const tokyo: WorkingHours = {
      timezone: "Asia/Tokyo",
      startHour: 9,
      endHour: 18,
    };

    expect(isWithinWorkingHours(tokyo, utc(9))).toBe(false);
    // 00:00 UTC is 09:00 in Tokyo — right at the start of the window.
    expect(isWithinWorkingHours(tokyo, utc(0))).toBe(true);
  });
});

describe("isValidTimeZone", () => {
  it("accepts a well-formed IANA time zone", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects a made-up time zone name", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});
