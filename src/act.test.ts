import { describe, expect, it } from "vitest";
import { act } from "./act.js";
import type { Exec } from "./tracker.js";
import { CLAIM_MARKER, RELEASE_MARKER } from "./types.js";

function recordingExec(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  return { exec, calls };
}

describe("act", () => {
  it("executes releases and claims in plan order via the tracker", async () => {
    const { exec, calls } = recordingExec();
    const lines: string[] = [];

    await act(
      [
        { type: "release", ticket: 4, assignees: ["operator"] },
        { type: "claim", ticket: 9 },
      ],
      exec,
      (line) => lines.push(line),
    );

    expect(calls).toEqual([
      ["gh", "issue", "edit", "4", "--remove-assignee", "operator"],
      ["gh", "issue", "comment", "4", "--body", expect.stringContaining(RELEASE_MARKER)],
      ["gh", "issue", "edit", "9", "--add-assignee", "@me"],
      ["gh", "issue", "comment", "9", "--body", expect.stringContaining(CLAIM_MARKER)],
    ]);
    expect(lines).toEqual(["released #4 (orphaned claim)", "claimed #9"]);
  });

  it("performs no writes for an empty plan", async () => {
    const { exec, calls } = recordingExec();

    await act([], exec, () => {});

    expect(calls).toEqual([]);
  });
});
