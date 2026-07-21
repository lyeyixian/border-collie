import { describe, expect, it } from "vitest";
import { run, runStatus, type RunDeps } from "./run.js";
import type { Action, MergedAgentPr, Ticket, WorldSnapshot } from "./types.js";

function ticket(overrides: Partial<Ticket> & { number: number }): Ticket {
  return {
    title: `Ticket #${overrides.number}`,
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    hasAgentClaim: false,
    agentClaimCount: 0,
    attemptFailures: [],
    ...overrides,
  };
}

function world(
  tickets: Ticket[],
  openAgentPrTickets: number[] = [],
  mergedAgentPrs: MergedAgentPr[] = [],
): WorldSnapshot {
  return { tickets, openAgentPrTickets, mergedAgentPrs };
}

describe("runStatus", () => {
  it("is complete when every ticket in Scope is closed", () => {
    const status = runStatus(
      world([ticket({ number: 2, state: "closed" }), ticket({ number: 3, state: "closed" })]),
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

    expect(runStatus(world([ticket({ number: 2 })]), actions)).toEqual({ state: "running" });
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
});

/** Scripted ticks: each call shifts the next {world, actions} off the list. */
function scriptedDeps(script: { world: WorldSnapshot; actions: Action[] }[]): {
  deps: RunDeps;
  ticks: number;
  sleeps: number[];
  lines: string[];
} {
  const state = {
    ticks: 0,
    sleeps: [] as number[],
    lines: [] as string[],
    deps: {} as RunDeps,
  };
  state.deps = {
    tick: async () => {
      const next = script.shift();
      if (next === undefined) throw new Error("tick called past the end of the script");
      state.ticks += 1;
      return next;
    },
    sleep: async (ms) => {
      state.sleeps.push(ms);
    },
    log: (line) => {
      state.lines.push(line);
    },
  };
  return state;
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
    expect(state.lines.some((line) => line.includes("Complete"))).toBe(true);
  });

  it("exits stuck with a report naming the open tickets", async () => {
    const state = scriptedDeps([
      {
        world: world([ticket({ number: 7, title: "Needs a human", labels: ["ready-for-human"] })]),
        actions: [],
      },
    ]);

    const outcome = await run(30, state.deps);

    expect(outcome).toBe("stuck");
    expect(state.sleeps).toEqual([]);
    expect(state.lines.join("\n")).toContain("Stuck");
    expect(state.lines.join("\n")).toContain("#7");
  });
});
