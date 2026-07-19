import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import type { Ticket, WorldSnapshot } from "./types.js";

function ticket(overrides: Partial<Ticket> & { number: number }): Ticket {
  return {
    title: `Ticket #${overrides.number}`,
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    hasAgentClaim: false,
    ...overrides,
  };
}

function world(tickets: Ticket[], openAgentPrTickets: number[] = []): WorldSnapshot {
  return { tickets, openAgentPrTickets };
}

describe("plan", () => {
  it("claims a dispatchable ticket", () => {
    const actions = plan(world([ticket({ number: 7 })]), { maxWorkers: 3 });

    expect(actions).toEqual([{ type: "claim", ticket: 7 }]);
  });

  it("produces no actions for an empty world", () => {
    expect(plan(world([]), { maxWorkers: 3 })).toEqual([]);
  });

  it("excludes closed tickets", () => {
    const actions = plan(
      world([ticket({ number: 1, state: "closed" })]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes assigned tickets", () => {
    const actions = plan(
      world([ticket({ number: 1, assignees: ["some-human"] })]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes tickets without the ready-for-agent label", () => {
    const actions = plan(
      world([
        ticket({ number: 1, labels: [] }),
        ticket({ number: 2, labels: ["ready-for-human"] }),
      ]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("excludes tickets with open blockers", () => {
    const actions = plan(
      world([ticket({ number: 1, openBlockers: 2 })]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("releases an orphaned agent claim: assigned with marker, no open agent PR", () => {
    const actions = plan(
      world([ticket({ number: 5, assignees: ["operator"], hasAgentClaim: true })]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([{ type: "release", ticket: 5, assignees: ["operator"] }]);
  });

  it("keeps an agent claim whose ticket has an open agent PR", () => {
    const actions = plan(
      world(
        [ticket({ number: 5, assignees: ["operator"], hasAgentClaim: true })],
        [5],
      ),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("never touches a human claim: assigned without the marker comment", () => {
    const actions = plan(
      world([ticket({ number: 5, assignees: ["some-human"] })]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("does not release a closed ticket that still carries the marker", () => {
    const actions = plan(
      world([
        ticket({ number: 5, state: "closed", assignees: ["operator"], hasAgentClaim: true }),
      ]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([]);
  });

  it("plans releases before claims, and does not claim a just-released ticket this tick", () => {
    const actions = plan(
      world([
        ticket({ number: 9 }),
        ticket({ number: 4, assignees: ["operator"], hasAgentClaim: true }),
      ]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([
      { type: "release", ticket: 4, assignees: ["operator"] },
      { type: "claim", ticket: 9 },
    ]);
  });

  it("caps claims at maxWorkers, lowest ticket numbers first", () => {
    const actions = plan(
      world([
        ticket({ number: 9 }),
        ticket({ number: 4 }),
        ticket({ number: 12 }),
        ticket({ number: 6 }),
        ticket({ number: 2 }),
      ]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 2 },
      { type: "claim", ticket: 4 },
      { type: "claim", ticket: 6 },
    ]);
  });

  it("claims every dispatchable ticket when under the cap", () => {
    const actions = plan(
      world([
        ticket({ number: 3 }),
        ticket({ number: 5, openBlockers: 1 }),
        ticket({ number: 8 }),
      ]),
      { maxWorkers: 3 },
    );

    expect(actions).toEqual([
      { type: "claim", ticket: 3 },
      { type: "claim", ticket: 8 },
    ]);
  });
});
