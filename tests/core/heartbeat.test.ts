import { describe, expect, it } from "vitest";
import {
  heartbeatSnapshot,
  type WorkerActivity,
} from "../../src/core/heartbeat.js";

function activity(overrides: Partial<WorkerActivity> = {}): WorkerActivity {
  return {
    ticket: 4,
    attempt: 1,
    startedAtMs: 0,
    lastActivityAtMs: 0,
    ...overrides,
  };
}

describe("heartbeatSnapshot", () => {
  it("reports elapsed time and time since output independently", () => {
    const workers = [
      activity({ ticket: 4, startedAtMs: 0, lastActivityAtMs: 20_000 }),
    ];

    expect(heartbeatSnapshot(workers, 90_000)).toEqual([
      { ticket: 4, attempt: 1, elapsedMs: 90_000, sinceOutputMs: 70_000 },
    ]);
  });

  it("reports zero time since output for a Worker whose latest chunk landed just now", () => {
    const workers = [
      activity({ ticket: 4, startedAtMs: 0, lastActivityAtMs: 90_000 }),
    ];

    expect(heartbeatSnapshot(workers, 90_000)).toEqual([
      { ticket: 4, attempt: 1, elapsedMs: 90_000, sinceOutputMs: 0 },
    ]);
  });

  it("snapshots every in-flight Worker, keeping each reading independent", () => {
    const workers = [
      activity({
        ticket: 2,
        attempt: 1,
        startedAtMs: 0,
        lastActivityAtMs: 60_000,
      }),
      activity({
        ticket: 4,
        attempt: 2,
        startedAtMs: 30_000,
        lastActivityAtMs: 119_000,
      }),
    ];

    expect(heartbeatSnapshot(workers, 120_000)).toEqual([
      { ticket: 2, attempt: 1, elapsedMs: 120_000, sinceOutputMs: 60_000 },
      { ticket: 4, attempt: 2, elapsedMs: 90_000, sinceOutputMs: 1_000 },
    ]);
  });

  it("answers empty for no in-flight Workers", () => {
    expect(heartbeatSnapshot([], 60_000)).toEqual([]);
  });
});
