import { describe, expect, it } from "vitest";
import {
  classifyInfrastructure,
  lastResultLine,
  parseResultEvent,
  reclassifyCorrelatedFailures,
} from "./classify.js";
import type { WorkerOutcome } from "./worker.js";

describe("classifyInfrastructure", () => {
  it("classifies a usage-limit death", () => {
    expect(classifyInfrastructure("Claude AI usage limit reached|1769000000")).toBe("usage-limit");
    expect(classifyInfrastructure('{"error":{"type":"usage_limit_reached"}}')).toBe("usage-limit");
  });

  it("classifies a rate-limit death", () => {
    expect(classifyInfrastructure('API Error: 429 {"type":"rate_limit_error"}')).toBe("rate-limit");
    expect(classifyInfrastructure('{"type":"overloaded_error"}')).toBe("rate-limit");
  });

  it("classifies an auth death", () => {
    expect(classifyInfrastructure('{"type":"authentication_error","message":"invalid x-api-key"}')).toBe(
      "auth",
    );
    expect(classifyInfrastructure("Invalid API key · Please run /login")).toBe("auth");
    expect(classifyInfrastructure("OAuth token has expired")).toBe("auth");
  });

  it("classifies a network death", () => {
    expect(classifyInfrastructure("Error: getaddrinfo ENOTFOUND api.anthropic.com")).toBe("network");
    expect(classifyInfrastructure("TypeError: fetch failed\n  cause: ECONNRESET")).toBe("network");
  });

  it("prefers the most specific class when signatures overlap", () => {
    // A rate-limited request often also logs connection retries.
    expect(classifyInfrastructure("rate_limit_error after retry: connection reset")).toBe(
      "rate-limit",
    );
  });

  it("returns undefined for ordinary ticket-failure output", () => {
    expect(classifyInfrastructure("Error: tests failed\n  expected 2 to be 3")).toBeUndefined();
    expect(classifyInfrastructure("")).toBeUndefined();
  });
});

describe("parseResultEvent", () => {
  it("reads subtype, cost, and turns from the last result event", () => {
    const tail = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","subtype":"success","total_cost_usd":1.25,"num_turns":40}',
    ].join("\n");

    expect(parseResultEvent(tail)).toEqual({
      subtype: "success",
      totalCostUsd: 1.25,
      numTurns: 40,
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
    expect(parseResultEvent('{"type":"assistant"}\nplain text')).toBeUndefined();
    expect(parseResultEvent("")).toBeUndefined();
  });

  it("tolerates a result event missing the optional fields", () => {
    expect(parseResultEvent('{"type":"result"}')).toEqual({
      subtype: undefined,
      totalCostUsd: undefined,
      numTurns: undefined,
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
    expect(lastResultLine('{"type":"assistant"}\nprose about rate limits')).toBe("");
  });
});

function outcome(ticket: number, overrides: Partial<WorkerOutcome> = {}): WorkerOutcome {
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
    const outcomes = reclassifyCorrelatedFailures([failed(2, "stall"), failed(4, "timeout")]);

    expect(outcomes.map((o) => o.failure)).toEqual(["stall", "timeout"]);
    expect(outcomes.every((o) => o.infra === undefined)).toBe(true);
  });

  it("leaves a single failure alone — one death is a ticket failure until proven otherwise", () => {
    const outcomes = reclassifyCorrelatedFailures([failed(2, "no-commits"), outcome(4)]);

    expect(outcomes[0]?.failure).toBe("no-commits");
  });

  it("never reclassifies budget breaches: a measured budget proves the environment was up", () => {
    const outcomes = reclassifyCorrelatedFailures([failed(2, "budget"), failed(4, "budget")]);

    expect(outcomes.map((o) => o.failure)).toEqual(["budget", "budget"]);
  });

  it("never reclassifies clean no-commit exits: a Worker that ran to completion proves the same", () => {
    const outcomes = reclassifyCorrelatedFailures([
      failed(2, "no-commits"),
      failed(4, "no-commits"),
    ]);

    expect(outcomes.map((o) => o.failure)).toEqual(["no-commits", "no-commits"]);
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
