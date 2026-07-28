import { describe, expect, it } from "vitest";
import { type RunDeps, run, runStatus } from "../../src/app/run.js";
import { BREAKER_BASE_COOLDOWN_MS } from "../../src/core/breaker.js";
import type { Log, LogEvent } from "../../src/core/log.js";
import type {
  Action,
  MergedAgentPr,
  OpenAgentPr,
  Ticket,
  WorldSnapshot,
} from "../../src/core/types.js";

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
    ...overrides,
  };
}

function openPr(ticket: number): OpenAgentPr {
  return {
    number: ticket * 10,
    ticket,
    headRef: `border-collie/ticket-${ticket}-attempt-1`,
    draft: false,
    mergeable: "mergeable",
    behind: false,
    ci: "passing",
    conflictWorkerAsked: false,
  };
}

function world(
  tickets: Ticket[],
  openAgentPrTickets: number[] = [],
  mergedAgentPrs: MergedAgentPr[] = [],
): WorldSnapshot {
  return {
    tickets,
    openAgentPrs: openAgentPrTickets.map(openPr),
    mergedAgentPrs,
  };
}

describe("runStatus", () => {
  it("is complete when every ticket in Scope is closed", () => {
    const status = runStatus(
      world([
        ticket({ number: 2, state: "closed" }),
        ticket({ number: 3, state: "closed" }),
      ]),
      [],
    );

    expect(status).toEqual({ state: "complete" });
  });

  it("is complete for an empty Scope", () => {
    expect(runStatus(world([]), [])).toEqual({ state: "complete" });
  });

  it("keeps running while the tick planned actions", () => {
    const actions: Action[] = [
      { type: "claim", ticket: 2 },
      { type: "spawn", ticket: 2, attempt: 1 },
    ];

    expect(runStatus(world([ticket({ number: 2 })]), actions)).toEqual({
      state: "running",
    });
  });

  it("keeps running while agent PRs await human merge, even with nothing planned", () => {
    const snapshot = world(
      [ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true })],
      [2],
    );

    expect(runStatus(snapshot, [])).toEqual({ state: "running" });
  });

  it("is stuck when open tickets remain but nothing is planned and no agent PR is open", () => {
    const humanTicket = ticket({ number: 2, labels: ["ready-for-human"] });

    expect(runStatus(world([humanTicket]), [])).toEqual({
      state: "stuck",
      open: [humanTicket],
    });
  });

  it("is stuck despite out-of-scope agent PRs: their merge cannot move this Scope", () => {
    const humanTicket = ticket({ number: 2, labels: ["ready-for-human"] });

    expect(runStatus(world([humanTicket], [99]), [])).toEqual({
      state: "stuck",
      open: [humanTicket],
    });
  });

  it("keeps running while a dispatchable ticket waits on headroom held by out-of-scope PRs", () => {
    // Dispatch was throttled to nothing (actions empty), but the ticket
    // becomes claimable the moment the foreign PRs merge — not stuck.
    expect(runStatus(world([ticket({ number: 2 })], [99]), [])).toEqual({
      state: "running",
    });
  });

  it("is never stuck while the circuit breaker holds dispatch paused — recovery is the path forward", () => {
    const held = ticket({
      number: 2,
      assignees: ["operator"],
      hasAgentClaim: true,
    });

    expect(runStatus(world([held]), [], true)).toEqual({ state: "running" });
  });
});

/**
 * Scripted ticks: each call shifts the next {world, actions, infraFailures}
 * off the list, recording the dispatchPaused flag it was called with. The
 * clock advances one poll interval per sleep, so probe cooldowns are
 * exercised in fake time; probe answers shift off `probeAnswers`.
 */
function scriptedDeps(
  script: { world: WorldSnapshot; actions: Action[]; infraFailures?: number }[],
  opts: { probeAnswers?: boolean[]; msPerSleep?: number } = {},
): {
  deps: RunDeps;
  ticks: number;
  pausedFlags: boolean[];
  probes: number;
  sleeps: number[];
  events: LogEvent[];
} {
  const state = {
    ticks: 0,
    pausedFlags: [] as boolean[],
    probes: 0,
    sleeps: [] as number[],
    events: [] as LogEvent[],
    deps: {} as RunDeps,
  };
  let nowMs = 0;
  state.deps = {
    tick: async (dispatchPaused) => {
      const next = script.shift();
      if (next === undefined)
        throw new Error("tick called past the end of the script");
      state.ticks += 1;
      state.pausedFlags.push(dispatchPaused);
      return { infraFailures: 0, ...next };
    },
    probe: async () => {
      state.probes += 1;
      const answer = opts.probeAnswers?.shift();
      if (answer === undefined)
        throw new Error("probe called past the end of the script");
      return answer;
    },
    now: () => nowMs,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      nowMs += opts.msPerSleep ?? ms;
    },
    log: recordingLog(state.events),
  };
  return state;
}

/** A `Log` recording every event into `events`; the run loop never derives a sub-logger, but the type requires `child`. */
function recordingLog(events: LogEvent[]): Log {
  const fn = ((event: LogEvent) => {
    events.push(event);
  }) as Log;
  fn.child = () => recordingLog(events);
  return fn;
}

describe("run", () => {
  it("ticks, sleeps the poll interval, and ticks again until a terminal state", async () => {
    const inFlight = world(
      [ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true })],
      [2],
    );
    const done = world([ticket({ number: 2, state: "closed" })]);
    const state = scriptedDeps([
      { world: inFlight, actions: [] },
      { world: inFlight, actions: [] },
      { world: done, actions: [] },
    ]);

    const outcome = await run(45, state.deps);

    expect(outcome).toBe("complete");
    expect(state.ticks).toBe(3);
    expect(state.sleeps).toEqual([45_000, 45_000]);
  });

  it("exits complete without sleeping when the first tick finds Scope closed", async () => {
    const state = scriptedDeps([
      { world: world([ticket({ number: 2, state: "closed" })]), actions: [] },
    ]);

    const outcome = await run(30, state.deps);

    expect(outcome).toBe("complete");
    expect(state.sleeps).toEqual([]);
    expect(state.events.some((e) => e.kind === "complete-report")).toBe(true);
  });

  it("logs a Complete summary report naming every ticket in Scope, at info", async () => {
    const state = scriptedDeps([
      {
        world: world([
          ticket({ number: 2, title: "Walking skeleton", state: "closed" }),
          ticket({
            number: 7,
            title: "Hard one",
            state: "closed",
            labels: ["ready-for-human"],
          }),
        ]),
        actions: [],
      },
    ]);

    await run(30, state.deps);

    const report = state.events.find(
      (e): e is Extract<LogEvent, { kind: "complete-report" }> =>
        e.kind === "complete-report",
    );
    expect(report?.level).toBe("info");
    expect(report?.report.tickets).toEqual([
      { ticket: 2, title: "Walking skeleton", escalated: false },
      { ticket: 7, title: "Hard one", escalated: true },
    ]);
  });

  it("trips the breaker on infrastructure failure, ticks paused, and resumes when the probe passes", async () => {
    const held = world([
      ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true }),
    ]);
    const state = scriptedDeps(
      [
        {
          world: held,
          actions: [
            { type: "claim", ticket: 2 },
            { type: "spawn", ticket: 2, attempt: 1 },
          ],
          infraFailures: 1,
        },
        { world: held, actions: [] }, // paused: would be stuck without the breaker
        { world: world([ticket({ number: 2, state: "closed" })]), actions: [] },
      ],
      // Each sleep advances half a cooldown: one paused Tick passes before the probe is due.
      { probeAnswers: [true], msPerSleep: BREAKER_BASE_COOLDOWN_MS / 2 },
    );

    const outcome = await run(30, state.deps);

    expect(outcome).toBe("complete");
    expect(state.pausedFlags).toEqual([false, true, false]);
    expect(state.probes).toBe(1);
    // Infrastructure failure is healthy-but-degraded, warn — not an alarm.
    const open = state.events.find((e) => e.kind === "breaker-open");
    expect(open?.level).toBe("warn");
    expect(open).toMatchObject({ infraFailures: 1 });
    // Recovery is the loop working again, info.
    const closed = state.events.find((e) => e.kind === "breaker-closed");
    expect(closed?.level).toBe("info");
  });

  it("re-trips on a failed probe and waits the doubled cooldown before probing again", async () => {
    const held = world([
      ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true }),
    ]);
    const state = scriptedDeps(
      [
        { world: held, actions: [], infraFailures: 1 },
        { world: held, actions: [] },
        { world: held, actions: [] },
        { world: world([ticket({ number: 2, state: "closed" })]), actions: [] },
      ],
      { probeAnswers: [false, true], msPerSleep: BREAKER_BASE_COOLDOWN_MS },
    );

    const outcome = await run(30, state.deps);

    expect(outcome).toBe("complete");
    // Trip at t0; probe fails at t1 (re-trip, cooldown doubled); not due at
    // t2; passes at t3 — so exactly two probes and three paused ticks.
    expect(state.probes).toBe(2);
    expect(state.pausedFlags).toEqual([false, true, true, false]);
    const stillOpen = state.events.find((e) => e.kind === "breaker-still-open");
    expect(stillOpen?.level).toBe("warn");
    expect(stillOpen).toMatchObject({ trips: 2 });
  });

  it("exits stuck with a report naming the open tickets, at warn", async () => {
    const state = scriptedDeps([
      {
        world: world([
          ticket({
            number: 7,
            title: "Needs a human",
            labels: ["ready-for-human"],
          }),
        ]),
        actions: [],
      },
    ]);

    const outcome = await run(30, state.deps);

    expect(outcome).toBe("stuck");
    expect(state.sleeps).toEqual([]);
    const report = state.events.find(
      (e): e is Extract<LogEvent, { kind: "stuck-report" }> =>
        e.kind === "stuck-report",
    );
    expect(report?.level).toBe("warn");
    expect(report?.report.tickets.map((t) => t.ticket)).toEqual([7]);
  });

  it("logs the poll wait at info between ticks", async () => {
    const inFlight = world(
      [ticket({ number: 2, assignees: ["operator"], hasAgentClaim: true })],
      [2],
    );
    const state = scriptedDeps([
      { world: inFlight, actions: [] },
      { world: world([ticket({ number: 2, state: "closed" })]), actions: [] },
    ]);

    await run(45, state.deps);

    const nextTick = state.events.find((e) => e.kind === "next-tick");
    expect(nextTick?.level).toBe("info");
    expect(nextTick).toMatchObject({ pollSeconds: 45 });
  });

  it("resumes from tracker truth when re-run after a human fixes a Stuck state", async () => {
    // Nothing but GitHub carries state: a run that exits Stuck ...
    const escalated = ticket({ number: 7, labels: ["ready-for-human"] });
    const first = scriptedDeps([{ world: world([escalated]), actions: [] }]);
    expect(await run(30, first.deps)).toBe("stuck");

    // ... is recovered by relabelling the ticket and simply running again.
    const relabelled = ticket({ number: 7 });
    const second = scriptedDeps([
      {
        world: world([relabelled]),
        actions: [
          { type: "claim", ticket: 7 },
          { type: "spawn", ticket: 7, attempt: 1 },
        ],
      },
      { world: world([ticket({ number: 7, state: "closed" })]), actions: [] },
    ]);
    expect(await run(30, second.deps)).toBe("complete");
    expect(second.ticks).toBe(2);
  });
});
