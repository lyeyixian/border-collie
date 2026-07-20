import { describe, expect, it } from "vitest";
import {
  attemptMarker,
  parseAttemptMarker,
  ticketFromAgentBranch,
  type AttemptFailure,
} from "./types.js";

const FAILURE: AttemptFailure = {
  attempt: 1,
  reason: "timeout",
  model: "sonnet",
  branch: "border-collie/ticket-7",
  transcript: ".border-collie/transcripts/ticket-7.jsonl",
};

describe("attemptMarker", () => {
  it("round-trips an attempt failure through a hidden HTML marker", () => {
    const body = `${attemptMarker(FAILURE)}\n🐕 Attempt 1 failed.`;

    expect(parseAttemptMarker(body)).toEqual(FAILURE);
  });

  it("parses nothing from a body without the marker", () => {
    expect(parseAttemptMarker("🐕 released an orphaned claim")).toBeUndefined();
  });

  it("parses nothing from a mangled marker payload", () => {
    expect(parseAttemptMarker("<!-- border-collie:attempt not-json -->")).toBeUndefined();
  });

  it("parses nothing from valid JSON that is not an attempt record", () => {
    expect(parseAttemptMarker('<!-- border-collie:attempt {"attempt":1} -->')).toBeUndefined();
    expect(parseAttemptMarker("<!-- border-collie:attempt null -->")).toBeUndefined();
    expect(
      parseAttemptMarker(
        `<!-- border-collie:attempt ${JSON.stringify({ ...FAILURE, reason: "made-up" })} -->`,
      ),
    ).toBeUndefined();
  });
});

describe("ticketFromAgentBranch", () => {
  it("extracts the ticket number, tolerating a slug suffix", () => {
    expect(ticketFromAgentBranch("border-collie/ticket-8")).toBe(8);
    expect(ticketFromAgentBranch("border-collie/ticket-8-slug")).toBe(8);
    expect(ticketFromAgentBranch("feature/other")).toBeUndefined();
  });
});
