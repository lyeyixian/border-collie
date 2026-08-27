import { describe, expect, it, vi } from "vitest";
import { type DaemonDeps, daemon } from "../../src/app/daemon.js";
import type { TickResult } from "../../src/app/tick.js";
import { BREAKER_BASE_COOLDOWN_MS } from "../../src/core/breaker.js";
import type { Log, LogEvent } from "../../src/core/log.js";

class StopDaemon extends Error {}

/** Yields until every microtask queued so far (including a fire-and-forget Tick's own chain) has drained, before the caller advances any state a due-check reads. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeLog(): { log: Log; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const log = ((event: LogEvent): void => {
    events.push(event);
  }) as Log;
  log.child = () => log;
  return { log, events };
}

function tickResult(overrides: Partial<TickResult> = {}): TickResult {
  return {
    world: { tickets: [], openAgentPrs: [], mergedAgentPrs: [] },
    actions: [],
    infraFailures: 0,
    dispatchPaused: false,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DaemonDeps> = {}): {
  deps: DaemonDeps;
  events: LogEvent[];
} {
  const { log, events } = fakeLog();
  const deps: DaemonDeps = {
    listFleet: async () => [],
    mintToken: async (repository) => `token-${repository}`,
    tick: async () => tickResult(),
    pruneTranscripts: async () => [],
    probe: async () => true,
    now: () => 0,
    sleep: async () => {},
    log,
    pollSeconds: 30,
    ...overrides,
  };
  return { deps, events };
}

describe("daemon", () => {
  it("ticks each due repository once per poll, each with its own repository-scoped token", async () => {
    const tickCalls: { repository: string; token: string }[] = [];
    const { deps } = baseDeps({
      listFleet: async () => ["acme/widget", "acme/gizmo"],
      tick: async (repository, token) => {
        tickCalls.push({ repository, token });
        return tickResult();
      },
      sleep: async () => {
        await flush();
        throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(tickCalls).toHaveLength(2));

    expect(tickCalls).toEqual(
      expect.arrayContaining([
        { repository: "acme/widget", token: "token-acme/widget" },
        { repository: "acme/gizmo", token: "token-acme/gizmo" },
      ]),
    );
  });

  it("never starts a second Tick for a repository whose Tick has not settled", async () => {
    let releaseWidget: (() => void) | undefined;
    const tickCalls: string[] = [];
    let pollCount = 0;
    const { deps } = baseDeps({
      listFleet: async () => ["acme/widget"],
      tick: async (repository) => {
        tickCalls.push(repository);
        await new Promise<void>((resolve) => {
          releaseWidget = resolve;
        });
        return tickResult();
      },
      sleep: async () => {
        await flush();
        pollCount++;
        if (pollCount >= 2) throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(2));

    // Two polls passed while the one Tick above never settled; it must have
    // been dispatched exactly once.
    expect(tickCalls).toEqual(["acme/widget"]);
    releaseWidget?.();
  });

  it("does not let one repository's slow Tick delay a sibling's from starting or finishing", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseWidget: (() => void) | undefined;
    const { deps } = baseDeps({
      listFleet: async () => ["acme/widget", "acme/gizmo"],
      tick: async (repository) => {
        started.push(repository);
        if (repository === "acme/widget") {
          await new Promise<void>((resolve) => {
            releaseWidget = resolve;
          });
        }
        finished.push(repository);
        return tickResult();
      },
      sleep: async () => {
        await flush();
        throw new StopDaemon();
      },
    });

    const daemonPromise = daemon(deps);
    // Attached immediately so Node never sees this as unhandled while the
    // assertions below run before the awaited rejection at the bottom.
    daemonPromise.catch(() => {});
    await vi.waitFor(() =>
      expect(started.sort()).toEqual(["acme/gizmo", "acme/widget"]),
    );
    // The fast sibling finished without waiting on the slow one.
    expect(finished).toEqual(["acme/gizmo"]);

    releaseWidget?.();
    await vi.waitFor(() => expect(finished).toContain("acme/widget"));
    await expect(daemonPromise).rejects.toThrow(StopDaemon);
  });

  it("reports and skips a repository whose Tick fails, without affecting the rest of the fleet", async () => {
    const ticked: string[] = [];
    const { deps, events } = baseDeps({
      listFleet: async () => ["acme/broken", "acme/widget"],
      tick: async (repository) => {
        if (repository === "acme/broken") {
          throw new Error("connection reset");
        }
        ticked.push(repository);
        return tickResult();
      },
      sleep: async () => {
        await flush();
        throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(ticked).toEqual(["acme/widget"]));

    const unreachable = events.find(
      (e) => e.kind === "daemon-repository-unreachable",
    );
    expect(unreachable?.level).toBe("error");
    expect(unreachable).toMatchObject({ reason: "connection reset" });
  });

  it("releases a failed repository's lock, so it is due again next poll", async () => {
    let attempts = 0;
    const { deps } = baseDeps({
      // A poll interval of zero, so a repository whose clock never advances
      // (the fake `now` below) is still due again the very next poll —
      // isolating this test to the lock alone, not the round-robin timing
      // `core/fleet.ts` already covers on its own.
      pollSeconds: 0,
      listFleet: async () => ["acme/flaky"],
      tick: async () => {
        attempts++;
        if (attempts === 1) throw new Error("rate limited");
        return tickResult();
      },
      sleep: async () => {
        await flush();
        if (attempts >= 2) throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(attempts).toBe(2));
  });

  it("reports and retries next poll when the fleet itself cannot be listed, without ticking anything", async () => {
    let pollCount = 0;
    const ticked: string[] = [];
    const { deps, events } = baseDeps({
      listFleet: async () => {
        throw new Error("installation revoked");
      },
      tick: async (repository) => {
        ticked.push(repository);
        return tickResult();
      },
      sleep: async () => {
        pollCount++;
        if (pollCount >= 2) throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);

    expect(ticked).toEqual([]);
    const unreachable = events.filter(
      (e) => e.kind === "daemon-fleet-unreachable",
    );
    expect(unreachable.length).toBeGreaterThanOrEqual(2);
    expect(unreachable[0]?.level).toBe("error");
    expect(unreachable[0]).toMatchObject({ reason: "installation revoked" });
  });

  it("trips a repository's own circuit breaker on infrastructure failure and resumes once its probe passes", async () => {
    let nowMs = 0;
    let pollIndex = 0;
    const dispatchPausedSeen: boolean[] = [];
    let probeCalls = 0;
    const { deps, events } = baseDeps({
      now: () => nowMs,
      listFleet: async () => ["acme/widget"],
      tick: async (_repository, _token, dispatchPaused) => {
        dispatchPausedSeen.push(dispatchPaused);
        return tickResult({
          infraFailures: dispatchPausedSeen.length === 1 ? 1 : 0,
        });
      },
      probe: async () => {
        probeCalls++;
        return true;
      },
      sleep: async () => {
        await flush();
        pollIndex++;
        nowMs += BREAKER_BASE_COOLDOWN_MS / 2;
        if (pollIndex >= 3) throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() =>
      expect(dispatchPausedSeen.length).toBeGreaterThanOrEqual(3),
    );

    // Tripped on the first Tick's infra failure; still paused one poll later
    // (cooldown not yet elapsed); closed by the third poll's probe.
    expect(dispatchPausedSeen.slice(0, 3)).toEqual([false, true, false]);
    expect(probeCalls).toBe(1);
    const open = events.find((e) => e.kind === "breaker-open");
    expect(open?.level).toBe("warn");
    const closed = events.find((e) => e.kind === "breaker-closed");
    expect(closed?.level).toBe("info");
  });

  it("re-trips a repository's breaker on a failed probe and waits the doubled cooldown before probing again", async () => {
    let nowMs = 0;
    let pollIndex = 0;
    const probeAnswers = [false, true];
    let probeCalls = 0;
    const { deps, events } = baseDeps({
      now: () => nowMs,
      listFleet: async () => ["acme/widget"],
      tick: async () => tickResult({ infraFailures: pollIndex === 0 ? 1 : 0 }),
      probe: async () => {
        const answer = probeAnswers[probeCalls] ?? true;
        probeCalls++;
        return answer;
      },
      sleep: async () => {
        await flush();
        pollIndex++;
        nowMs += BREAKER_BASE_COOLDOWN_MS;
        if (pollIndex >= 4) throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(probeCalls).toBe(2));

    const stillOpen = events.find((e) => e.kind === "breaker-still-open");
    expect(stillOpen?.level).toBe("warn");
    expect(stillOpen).toMatchObject({ trips: 2 });
  });

  it("runs the transcript retention sweep once per repository, after that repository's Tick", async () => {
    const order: string[] = [];
    const sweptRepositories: string[] = [];
    const { deps } = baseDeps({
      listFleet: async () => ["acme/widget"],
      tick: async (repository) => {
        order.push(`tick:${repository}`);
        return tickResult();
      },
      pruneTranscripts: async (repository) => {
        order.push(`sweep:${repository}`);
        sweptRepositories.push(repository);
        return [];
      },
      sleep: async () => {
        await flush();
        throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() => expect(sweptRepositories).toEqual(["acme/widget"]));

    expect(order).toEqual(["tick:acme/widget", "sweep:acme/widget"]);
  });

  it("reports a failed sweep for that repository without failing its Tick or touching a sibling", async () => {
    const ticked: string[] = [];
    const swept: string[] = [];
    const { deps, events } = baseDeps({
      listFleet: async () => ["acme/broken", "acme/widget"],
      tick: async (repository) => {
        ticked.push(repository);
        return tickResult();
      },
      pruneTranscripts: async (repository) => {
        if (repository === "acme/broken") {
          throw new Error("disk full");
        }
        swept.push(repository);
        return [];
      },
      sleep: async () => {
        await flush();
        throw new StopDaemon();
      },
    });

    await expect(daemon(deps)).rejects.toThrow(StopDaemon);
    await vi.waitFor(() =>
      expect(ticked.sort()).toEqual(["acme/broken", "acme/widget"]),
    );
    await vi.waitFor(() => expect(swept).toEqual(["acme/widget"]));

    // The Tick itself succeeded for the repository whose sweep failed — this
    // is not the generic "repository unreachable" path.
    expect(
      events.find((e) => e.kind === "daemon-repository-unreachable"),
    ).toBeUndefined();
    const failed = events.find((e) => e.kind === "transcript-sweep-failed");
    expect(failed?.level).toBe("warn");
    expect(failed).toMatchObject({ reason: "disk full" });
  });
});
