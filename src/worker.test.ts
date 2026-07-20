import { describe, expect, it } from "vitest";
import type { Exec } from "./tracker.js";
import {
  branchCommitSubjects,
  dispatchWorker,
  pushAgentBranch,
  workerPrompt,
  type SpawnWorkerProcess,
  type WorkerProcessRequest,
} from "./worker.js";

const WORKTREE = ".border-collie/worktrees/ticket-4";
const BRANCH = "border-collie/ticket-4";
const TRANSCRIPT = ".border-collie/transcripts/ticket-4.jsonl";

/**
 * Fake the git side of the subprocess seam: reads are answered from fixtures,
 * writes recorded. `removeThrows` simulates the (normal) case of no stale
 * worktree to remove.
 */
function fakeExec(opts: { newCommits?: string; removeThrows?: boolean } = {}): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "remove" && opts.removeThrows) {
      throw new Error("fatal: not a working tree");
    }
    if (args[0] === "rev-parse") return "base-sha\n";
    if (args[0] === "rev-list") return `${opts.newCommits ?? "0"}\n`;
    return "";
  };
  return { exec, calls };
}

function fakeSpawn(result: number | null | Error): {
  spawn: SpawnWorkerProcess;
  requests: WorkerProcessRequest[];
} {
  const requests: WorkerProcessRequest[] = [];
  const spawn: SpawnWorkerProcess = async (request) => {
    requests.push(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return { spawn, requests };
}

describe("workerPrompt", () => {
  it("contains only the ticket reference, the /implement invocation, and the PR-description instruction", () => {
    expect(workerPrompt(4)).toBe(
      "/implement issue #4\n\nWhen the work is committed, make your final message a pull request description for this branch: it will be used verbatim as the PR body.",
    );
  });
});

describe("dispatchWorker", () => {
  it("creates the worktree on an agent branch, runs claude headless in it, and cleans up (branch retained)", async () => {
    const { exec, calls } = fakeExec({ newCommits: "3" });
    const { spawn, requests } = fakeSpawn(0);

    await dispatchWorker(4, { model: "sonnet" }, exec, spawn);

    expect(calls).toEqual([
      ["git", "worktree", "remove", "--force", WORKTREE],
      ["git", "worktree", "prune"],
      ["git", "fetch", "origin"],
      ["git", "worktree", "add", WORKTREE, "-B", BRANCH, "origin/HEAD"],
      ["git", "rev-parse", BRANCH],
      ["git", "rev-list", "--count", `base-sha..${BRANCH}`],
      ["git", "worktree", "remove", "--force", WORKTREE],
    ]);
    expect(requests).toEqual([
      {
        cmd: "claude",
        args: [
          "-p",
          workerPrompt(4),
          "--model",
          "sonnet",
          "--output-format",
          "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ],
        cwd: WORKTREE,
        transcriptPath: TRANSCRIPT,
        stderrPath: ".border-collie/transcripts/ticket-4.stderr.log",
      },
    ]);
  });

  it("serializes git phases across concurrent dispatches (repo-level locks), keeping Workers concurrent", async () => {
    const calls: string[][] = [];
    // Every git call yields first, giving the sibling dispatch a chance to
    // interleave — only the lock keeps each setup block contiguous.
    const exec: Exec = async (cmd, args) => {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push([cmd, ...args]);
      if (args[0] === "rev-parse") return "base-sha\n";
      if (args[0] === "rev-list") return "1\n";
      return "";
    };
    const { spawn } = fakeSpawn(0);

    const outcomes = await Promise.all([
      dispatchWorker(1, { model: "sonnet" }, exec, spawn),
      dispatchWorker(2, { model: "sonnet" }, exec, spawn),
    ]);

    const setupBlock = (ticket: number) => [
      ["git", "worktree", "remove", "--force", `.border-collie/worktrees/ticket-${ticket}`],
      ["git", "worktree", "prune"],
      ["git", "fetch", "origin"],
      [
        "git",
        "worktree",
        "add",
        `.border-collie/worktrees/ticket-${ticket}`,
        "-B",
        `border-collie/ticket-${ticket}`,
        "origin/HEAD",
      ],
      ["git", "rev-parse", `border-collie/ticket-${ticket}`],
    ];
    expect(calls.slice(0, 10)).toEqual([...setupBlock(1), ...setupBlock(2)]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("succeeds when the process exits cleanly and new commits exist on the branch", async () => {
    const { exec } = fakeExec({ newCommits: "3" });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, { model: "sonnet" }, exec, spawn);

    expect(outcome).toEqual({
      ticket: 4,
      branch: BRANCH,
      base: "base-sha",
      transcript: TRANSCRIPT,
      exitCode: 0,
      newCommits: 3,
      ok: true,
    });
  });

  it("fails the attempt on a clean exit with no new commits", async () => {
    const { exec } = fakeExec({ newCommits: "0" });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, { model: "sonnet" }, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, exitCode: 0, newCommits: 0 });
  });

  it("fails the attempt on a non-zero exit even when commits exist", async () => {
    const { exec } = fakeExec({ newCommits: "2" });
    const { spawn } = fakeSpawn(1);

    const outcome = await dispatchWorker(4, { model: "sonnet" }, exec, spawn);

    expect(outcome).toMatchObject({ ok: false, exitCode: 1, newCommits: 2 });
  });

  it("tolerates worktree-remove failures: no stale worktree before, best-effort cleanup after", async () => {
    const { exec } = fakeExec({ newCommits: "1", removeThrows: true });
    const { spawn } = fakeSpawn(0);

    const outcome = await dispatchWorker(4, { model: "sonnet" }, exec, spawn);

    expect(outcome.ok).toBe(true);
  });

  it("still removes the worktree when spawning the process throws, then rethrows", async () => {
    const { exec, calls } = fakeExec();
    const { spawn } = fakeSpawn(new Error("spawn claude ENOENT"));

    await expect(dispatchWorker(4, { model: "sonnet" }, exec, spawn)).rejects.toThrow("ENOENT");

    expect(calls.at(-1)).toEqual(["git", "worktree", "remove", "--force", WORKTREE]);
  });

  it("runs the configured model", async () => {
    const { exec } = fakeExec({ newCommits: "1" });
    const { spawn, requests } = fakeSpawn(0);

    await dispatchWorker(7, { model: "opus" }, exec, spawn);

    expect(requests[0]?.args).toContain("opus");
  });
});

describe("pushAgentBranch", () => {
  it("force-pushes the agent branch to origin", async () => {
    const { exec, calls } = fakeExec();

    await pushAgentBranch(BRANCH, exec);

    expect(calls).toEqual([["git", "push", "--force", "origin", BRANCH]]);
  });
});

describe("branchCommitSubjects", () => {
  it("lists the Attempt's commit subjects oldest first", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "First commit\nSecond commit\n";
    };

    const subjects = await branchCommitSubjects("base-sha", BRANCH, exec);

    expect(calls).toEqual([["git", "log", "--format=%s", "--reverse", `base-sha..${BRANCH}`]]);
    expect(subjects).toEqual(["First commit", "Second commit"]);
  });
});
