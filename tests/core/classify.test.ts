import { describe, expect, it } from "vitest";
import {
  CORRELATED_WINDOW_MS,
  classifyInfrastructure,
  clusterWithinWindow,
  correlatedFailureTimestampsMs,
  lastResultLine,
  parseResultEvent,
  reclassifyCorrelatedFailures,
} from "../../src/core/classify.js";
import type {
  FailureReason,
  Ticket,
  WorkerOutcome,
} from "../../src/core/types.js";

describe("classifyInfrastructure", () => {
  it("classifies a usage-limit death", () => {
    expect(
      classifyInfrastructure("Claude AI usage limit reached|1769000000"),
    ).toBe("usage-limit");
    expect(
      classifyInfrastructure('{"error":{"type":"usage_limit_reached"}}'),
    ).toBe("usage-limit");
  });

  it("classifies a rate-limit death", () => {
    expect(
      classifyInfrastructure('API Error: 429 {"type":"rate_limit_error"}'),
    ).toBe("rate-limit");
    expect(classifyInfrastructure('{"type":"overloaded_error"}')).toBe(
      "rate-limit",
    );
  });

  it("classifies an auth death", () => {
    expect(
      classifyInfrastructure(
        '{"type":"authentication_error","message":"invalid x-api-key"}',
      ),
    ).toBe("auth");
    expect(classifyInfrastructure("Invalid API key · Please run /login")).toBe(
      "auth",
    );
    expect(classifyInfrastructure("OAuth token has expired")).toBe("auth");
  });

  it("classifies a network death", () => {
    expect(
      classifyInfrastructure("Error: getaddrinfo ENOTFOUND api.anthropic.com"),
    ).toBe("network");
    expect(
      classifyInfrastructure("TypeError: fetch failed\n  cause: ECONNRESET"),
    ).toBe("network");
  });

  it("prefers the most specific class when signatures overlap", () => {
    // A rate-limited request often also logs connection retries.
    expect(
      classifyInfrastructure("rate_limit_error after retry: connection reset"),
    ).toBe("rate-limit");
  });

  it("returns undefined for ordinary ticket-failure output", () => {
    expect(
      classifyInfrastructure("Error: tests failed\n  expected 2 to be 3"),
    ).toBeUndefined();
    expect(classifyInfrastructure("")).toBeUndefined();
  });
});

describe("parseResultEvent", () => {
  it("reads subtype, cost, turns, and duration from the last result event", () => {
    const tail = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","subtype":"success","total_cost_usd":1.25,"num_turns":40,"duration_ms":54000}',
    ].join("\n");

    expect(parseResultEvent(tail)).toEqual({
      subtype: "success",
      totalCostUsd: 1.25,
      numTurns: 40,
      durationMs: 54000,
    });
  });

  it("survives a tail whose first line was cut mid-JSON, and non-JSON noise", () => {
    const tail = [
      'cost_usd":0.4,"type":"result"}', // truncated head of the tail window
      "some stray stderr-looking line",
      '{"type":"result","subtype":"error_max_turns","total_cost_usd":9.5,"num_turns":200}',
    ].join("\n");

    expect(parseResultEvent(tail)?.subtype).toBe("error_max_turns");
  });

  it("returns undefined when no result event survived", () => {
    expect(
      parseResultEvent('{"type":"assistant"}\nplain text'),
    ).toBeUndefined();
    expect(parseResultEvent("")).toBeUndefined();
  });

  it("tolerates a result event missing the optional fields", () => {
    expect(parseResultEvent('{"type":"result"}')).toEqual({
      subtype: undefined,
      totalCostUsd: undefined,
      numTurns: undefined,
      durationMs: undefined,
    });
  });
});

describe("lastResultLine", () => {
  it("returns the raw last result-event line", () => {
    const tail = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","subtype":"success"}',
    ].join("\n");

    expect(lastResultLine(tail)).toBe('{"type":"result","subtype":"success"}');
  });

  it("returns the empty string when no result line exists", () => {
    expect(
      lastResultLine('{"type":"assistant"}\nprose about rate limits'),
    ).toBe("");
  });
});

function outcome(
  ticket: number,
  overrides: Partial<WorkerOutcome> = {},
): WorkerOutcome {
  return {
    ticket,
    attempt: 1,
    branch: `border-collie/ticket-${ticket}-attempt-1`,
    base: "base-sha",
    transcript: `.border-collie/transcripts/ticket-${ticket}-attempt-1.jsonl`,
    model: "sonnet",
    exitCode: 0,
    newCommits: 2,
    failure: undefined,
    infra: undefined,
    costUsd: undefined,
    turns: undefined,
    durationMs: undefined,
    subtype: undefined,
    costOverrun: false,
    ok: true,
    ...overrides,
  };
}

const failed = (ticket: number, failure: WorkerOutcome["failure"]) =>
  outcome(ticket, { failure, ok: false, exitCode: 1, newCommits: 0 });

describe("reclassifyCorrelatedFailures", () => {
  it("voids two Workers that failed the same way in one Tick as correlated infrastructure", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "nonzero-exit"),
      failed(4, "nonzero-exit"),
      outcome(6),
    ]);

    expect(outcomes.map((o) => [o.failure, o.infra])).toEqual([
      [undefined, "correlated"],
      [undefined, "correlated"],
      [undefined, undefined],
    ]);
  });

  it("leaves Workers that failed in different ways classified as ticket failures", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "stall"),
      failed(4, "timeout"),
    ]);

    expect(outcomes.map((o) => o.failure)).toEqual(["stall", "timeout"]);
    expect(outcomes.every((o) => o.infra === undefined)).toBe(true);
  });

  it("leaves a single failure alone — one death is a ticket failure until proven otherwise", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "no-commits"),
      outcome(4),
    ]);

    expect(outcomes[0]?.failure).toBe("no-commits");
  });

  it("never reclassifies budget breaches: a measured budget proves the environment was up", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "budget"),
      failed(4, "budget"),
    ]);

    expect(outcomes.map((o) => o.failure)).toEqual(["budget", "budget"]);
  });

  it("never reclassifies clean no-commit exits: a Worker that ran to completion proves the same", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "no-commits"),
      failed(4, "no-commits"),
    ]);

    expect(outcomes.map((o) => o.failure)).toEqual([
      "no-commits",
      "no-commits",
    ]);
    expect(outcomes.every((o) => o.infra === undefined)).toBe(true);
  });

  it("leaves already-classified infrastructure failures untouched", () => {
    const infra = outcome(2, { ok: false, infra: "usage-limit" });

    expect(reclassifyCorrelatedFailures([infra, failed(4, "stall")])).toEqual([
      infra,
      failed(4, "stall"),
    ]);
  });
});

function ticketWithFailure(
  lastFailureAtMs: number | undefined,
  lastFailureReason: FailureReason | undefined,
): Ticket {
  return {
    number: 1,
    title: "Ticket",
    state: "open",
    assignees: [],
    labels: ["ready-for-agent"],
    openBlockers: 0,
    blockedBy: [],
    hasAgentClaim: false,
    agentClaimCount: 1,
    attemptFailures: [],
    voidedAtMs: undefined,
    lastFailureAtMs,
    lastFailureReason,
    hasLiveWorker: false,
  };
}

describe("clusterWithinWindow", () => {
  it("groups timestamps within the window into one cluster", () => {
    expect(clusterWithinWindow([0, 500, 900], 1_000)).toEqual([[0, 500, 900]]);
  });

  it("starts a fresh cluster once a gap exceeds the window", () => {
    expect(clusterWithinWindow([0, 500, 2_000], 1_000)).toEqual([
      [0, 500],
      [2_000],
    ]);
  });

  it("measures each gap against the cluster's own latest member, not its first", () => {
    // 0 -> 900 -> 1_800: each successive gap is 900 (within the window), so
    // the whole run stays one cluster even though 1_800 is 1_800 past 0.
    expect(clusterWithinWindow([0, 900, 1_800], 1_000)).toEqual([
      [0, 900, 1_800],
    ]);
  });

  it("returns one singleton cluster per timestamp when nothing is close enough", () => {
    expect(clusterWithinWindow([0, 5_000, 10_000], 1_000)).toEqual([
      [0],
      [5_000],
      [10_000],
    ]);
  });

  it("returns no clusters for no timestamps", () => {
    expect(clusterWithinWindow([], CORRELATED_WINDOW_MS)).toEqual([]);
  });
});

describe("correlatedFailureTimestampsMs", () => {
  it("trips on two tickets whose latest release shares a correlatable reason within the window", () => {
    const tickets = [
      ticketWithFailure(1_000, "nonzero-exit"),
      ticketWithFailure(1_500, "nonzero-exit"),
    ];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([1_500]);
  });

  it("ignores a single failure — one death is a ticket failure until proven otherwise", () => {
    const tickets = [ticketWithFailure(1_000, "timeout")];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([]);
  });

  it("ignores tickets that failed in different ways", () => {
    const tickets = [
      ticketWithFailure(1_000, "stall"),
      ticketWithFailure(1_050, "timeout"),
    ];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([]);
  });

  it("never reclassifies budget breaches or clean no-commit exits, same as the batch heuristic", () => {
    const tickets = [
      ticketWithFailure(1_000, "budget"),
      ticketWithFailure(1_050, "budget"),
      ticketWithFailure(1_100, "no-commits"),
      ticketWithFailure(1_150, "no-commits"),
    ];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([]);
  });

  it("ignores tickets whose latest marker is no longer a Ticket-failure release", () => {
    const tickets = [
      ticketWithFailure(undefined, undefined),
      ticketWithFailure(undefined, undefined),
    ];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([]);
  });

  it("does not collapse two correlated pairs spaced beyond the window into one trip", () => {
    const tickets = [
      ticketWithFailure(0, "stall"),
      ticketWithFailure(500, "stall"),
      ticketWithFailure(CORRELATED_WINDOW_MS * 10, "stall"),
      ticketWithFailure(CORRELATED_WINDOW_MS * 10 + 500, "stall"),
    ];

    expect(correlatedFailureTimestampsMs(tickets)).toEqual([
      500,
      CORRELATED_WINDOW_MS * 10 + 500,
    ]);
  });
});
