import { describe, expect, it } from "vitest";
import {
  ensureCloseKeyword,
  fallbackBody,
  isSanePrBody,
  MAX_WORKER_BODY_LENGTH,
  openPrForOutcome,
  type ReadFile,
  workerFinalMessage,
} from "../../src/adapters/pr.js";
import type { Exec } from "../../src/adapters/tracker.js";
import type { WorkerOutcome } from "../../src/core/types.js";

const event = (fields: Record<string, unknown>) => JSON.stringify(fields);

const successResult = (result: string) =>
  event({ type: "result", subtype: "success", is_error: false, result });

describe("workerFinalMessage", () => {
  it("extracts the result text of the stream-json result event", () => {
    const transcript = [
      event({ type: "system", subtype: "init" }),
      event({ type: "assistant", message: { content: "working..." } }),
      successResult("A fine PR description."),
    ].join("\n");

    expect(workerFinalMessage(transcript)).toBe("A fine PR description.");
  });

  it("returns undefined for an empty transcript", () => {
    expect(workerFinalMessage("")).toBeUndefined();
  });

  it("returns undefined when the run did not end in success", () => {
    const transcript = event({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    });

    expect(workerFinalMessage(transcript)).toBeUndefined();
  });

  it("returns undefined when the success result is flagged as an error", () => {
    const transcript = event({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "an error message",
    });

    expect(workerFinalMessage(transcript)).toBeUndefined();
  });

  it("tolerates stray non-JSON lines around the events", () => {
    const transcript = [
      "not json at all",
      successResult("Still found."),
      "",
    ].join("\n");

    expect(workerFinalMessage(transcript)).toBe("Still found.");
  });

  it("uses the last result event when several exist", () => {
    const transcript = [successResult("first"), successResult("second")].join(
      "\n",
    );

    expect(workerFinalMessage(transcript)).toBe("second");
  });
});

describe("isSanePrBody", () => {
  it("accepts a normal description", () => {
    expect(isSanePrBody("Implements the thing.\n\nCloses #5")).toBe(true);
  });

  it("rejects a missing final message", () => {
    expect(isSanePrBody(undefined)).toBe(false);
  });

  it("rejects a blank final message", () => {
    expect(isSanePrBody("  \n\t")).toBe(false);
  });

  it("rejects a message beyond GitHub's body size limit", () => {
    expect(isSanePrBody("x".repeat(MAX_WORKER_BODY_LENGTH + 1))).toBe(false);
  });
});

describe("ensureCloseKeyword", () => {
  it("appends the close-on-merge keyword when the body lacks one", () => {
    expect(ensureCloseKeyword("A body.", 5)).toBe("A body.\n\nCloses #5");
  });

  it("leaves the body alone when it already closes the ticket", () => {
    expect(ensureCloseKeyword("A body.\n\nCloses #5", 5)).toBe(
      "A body.\n\nCloses #5",
    );
    expect(ensureCloseKeyword("Fixes #5 for real", 5)).toBe(
      "Fixes #5 for real",
    );
  });

  it("appends for keyword forms GitHub may not recognize (colon, newline)", () => {
    expect(ensureCloseKeyword("resolved: #5", 5)).toBe(
      "resolved: #5\n\nCloses #5",
    );
    expect(ensureCloseKeyword("closes\n#5", 5)).toBe("closes\n#5\n\nCloses #5");
  });

  it("appends when the body only closes a different ticket", () => {
    expect(ensureCloseKeyword("Closes #4", 5)).toBe("Closes #4\n\nCloses #5");
  });

  it("appends when the ticket number only appears without a keyword", () => {
    expect(ensureCloseKeyword("See #5 for context.", 5)).toBe(
      "See #5 for context.\n\nCloses #5",
    );
  });
});

const OUTCOME: WorkerOutcome = {
  ticket: 5,
  attempt: 1,
  branch: "border-collie/ticket-5",
  base: "base-sha",
  transcript: ".border-collie/transcripts/ticket-5.jsonl",
  model: "sonnet",
  exitCode: 0,
  newCommits: 2,
  failure: undefined,
  infra: undefined,
  costUsd: undefined,
  turns: undefined,
  costOverrun: false,
  ok: true,
};

/**
 * Fake the subprocess seam: `git log` answers with fixture commit subjects,
 * `gh pr create` with a PR URL; every call is recorded.
 */
function fakeExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "log")
      return "First commit\nSecond commit\n";
    if (cmd === "gh") return "https://github.com/o/r/pull/9\n";
    return "";
  };
  return { exec, calls };
}

const readAs =
  (content: string): ReadFile =>
  async () =>
    content;

describe("openPrForOutcome", () => {
  it("pushes the branch, then opens a draft PR titled from the ticket with the Worker's body", async () => {
    const { exec, calls } = fakeExec();
    const read = readAs(successResult("Adds the feature.\n\nCloses #5"));

    const url = await openPrForOutcome(OUTCOME, "PR opening", exec, read);

    expect(url).toBe("https://github.com/o/r/pull/9");
    expect(calls).toEqual([
      ["git", "push", "--force", "origin", "border-collie/ticket-5"],
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--head",
        "border-collie/ticket-5",
        "--title",
        "PR opening",
        "--body",
        "Adds the feature.\n\nCloses #5",
      ],
    ]);
  });

  it("appends the close-on-merge keyword when the Worker's body lacks it", async () => {
    const { exec, calls } = fakeExec();
    const read = readAs(successResult("Adds the feature."));

    await openPrForOutcome(OUTCOME, "PR opening", exec, read);

    expect(calls.at(-1)?.at(-1)).toBe("Adds the feature.\n\nCloses #5");
  });

  it("falls back to a mechanical body from the ticket and commit subjects when the sanity check fails", async () => {
    const { exec, calls } = fakeExec();
    const read = readAs(
      event({ type: "result", subtype: "error_during_execution" }),
    );

    await openPrForOutcome(OUTCOME, "PR opening", exec, read);

    expect(calls).toContainEqual([
      "git",
      "log",
      "--format=%s",
      "--reverse",
      "base-sha..border-collie/ticket-5",
    ]);
    const body = calls.at(-1)?.at(-1) ?? "";
    expect(body).toContain("PR opening");
    expect(body).toContain("- First commit");
    expect(body).toContain("- Second commit");
    expect(body).toContain("Closes #5");
  });

  it("falls back when the transcript cannot be read", async () => {
    const { exec, calls } = fakeExec();
    const read: ReadFile = async () => {
      throw new Error("ENOENT");
    };

    await openPrForOutcome(OUTCOME, "PR opening", exec, read);

    expect(calls.at(-1)?.at(-1)).toContain("- First commit");
  });
});

describe("fallbackBody", () => {
  it("names the ticket and lists the branch's commit subjects", () => {
    const body = fallbackBody(5, "PR opening", [
      "First commit",
      "Second commit",
    ]);

    expect(body).toContain("#5");
    expect(body).toContain("PR opening");
    expect(body).toContain("- First commit");
    expect(body).toContain("- Second commit");
  });
});
