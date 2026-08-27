import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/tracker.js";
import { tickOnce } from "../../src/app/tick.js";
import { resolveConfig } from "../../src/core/config.js";
import type { Log, LogEvent } from "../../src/core/log.js";
import { SCOPE_LABEL } from "../../src/core/types.js";

/** A `Log` that discards everything, for tests uninterested in narration. */
function fakeLog(): Log {
  const fn = ((_event: LogEvent) => {}) as Log;
  fn.child = () => fn;
  return fn;
}

const REPOSITORY = "acme/widgets";

/**
 * A real, writable directory: `dispatchContainerConflictWorker`/
 * `dispatchContainerRefinementWorker` (issue #198) ensure this exists on
 * disk before `docker run`, same as `dispatchContainerWorker` already does
 * for a Worker Attempt — a fixed path outside the test's own tmp tree would
 * fail that `mkdir` in a sandboxed test run.
 */
const TRANSCRIPTS_ROOT = mkdtempSync(
  join(tmpdir(), "border-collie-tick-test-"),
);

const SUB_ISSUES = "repos/{owner}/{repo}/issues/1/sub_issues?per_page=100";
const comments = (n: number) =>
  `repos/{owner}/{repo}/issues/${n}/comments?per_page=100`;
const pullComments = (n: number) =>
  `repos/{owner}/{repo}/pulls/${n}/comments?per_page=100`;
const pullReviews = (n: number) =>
  `repos/{owner}/{repo}/pulls/${n}/reviews?per_page=100`;
const CLOSED_PULLS = "repos/{owner}/{repo}/pulls?state=closed&per_page=100";

const issue = (overrides: Record<string, unknown>) => ({
  number: 5,
  title: "Walking skeleton",
  state: "open",
  assignees: [],
  labels: [{ name: "ready-for-agent" }, { name: SCOPE_LABEL }],
  issue_dependencies_summary: { blocked_by: 0 },
  ...overrides,
});

const prItem = (overrides: Record<string, unknown> = {}) => ({
  number: 50,
  headRefName: "border-collie/ticket-5-attempt-1",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [] as unknown[],
  ...overrides,
});

/**
 * `workingHours` left unset reads as outside working hours, which is when a
 * Conflict Worker and a Refinement round are allowed to spend quota
 * (core/plan.ts). Ticket 5 already has its open agent PR below, so nothing
 * here is claimable and the only dispatch a Tick can make is the PR-scoped
 * one under test.
 */
const config = resolveConfig({}, { kind: "parent", parent: 1 });

/**
 * Fake the subprocess seam for one whole Tick: the tracker reads that
 * `readScope` issues, `docker ps` (liveness, answered from `dockerPs`), and
 * the writes the act phase makes (`docker run`, `gh pr comment`), all
 * recorded. Anything else — a `git worktree add`, a `claude` spawn — throws,
 * so a Tick that fell back to the synchronous in-process path fails loudly
 * instead of silently running a session inline.
 */
function fakeExec(opts: { prList: unknown[]; dockerPs?: string }): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const api: Record<string, unknown> = {
    [SUB_ISSUES]: [[issue({})]],
    [comments(5)]: [[]],
    [comments(50)]: [[]],
    [pullComments(50)]: [[]],
    [pullReviews(50)]: [[]],
    [CLOSED_PULLS]: [[]],
  };
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh" && args[0] === "api") {
      const endpoint = args[1] ?? "";
      if (endpoint.startsWith("repos/{owner}/{repo}/compare/")) {
        return JSON.stringify({ behind_by: 0 });
      }
      if (!(endpoint in api)) {
        throw new Error(`unexpected gh api call: ${[cmd, ...args].join(" ")}`);
      }
      return JSON.stringify(api[endpoint]);
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(opts.prList);
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "comment") return "";
    if (cmd === "docker" && args[0] === "ps") return opts.dockerPs ?? "";
    if (cmd === "docker" && args[0] === "run") return "c0ffee\n";
    throw new Error(`unexpected call: ${[cmd, ...args].join(" ")}`);
  };
  return { exec, calls };
}

function runTick(exec: Exec) {
  return tickOnce(config, false, false, {
    log: fakeLog(),
    now: () => Date.UTC(2026, 0, 1, 3),
    scheduleInterval: () => () => {},
    // No checkout, so `requiredSkillMissing` is true — irrelevant here: a
    // Conflict Worker and a Refinement round invoke no skill and are the
    // one thing that gate leaves alone (core/plan.ts).
    cwd: "/nonexistent",
    exec,
    container: {
      repository: REPOSITORY,
      image: "ghcr.io/acme/border-collie-session:1",
      ghToken: "ghs_token",
      claudeCodeOAuthToken: "oauth_token",
      transcriptsRoot: TRANSCRIPTS_ROOT,
    },
  });
}

const dockerRuns = (calls: string[][]) =>
  calls.filter((c) => c[0] === "docker" && c[1] === "run");

describe("tickOnce on the daemon path (issue #181)", () => {
  it("dispatches a Conflict Worker into a PR-labelled session container and returns without running it inline", async () => {
    const { exec, calls } = fakeExec({
      prList: [prItem({ mergeable: "CONFLICTING" })],
    });

    const result = await runTick(exec);

    expect(result.actions).toContainEqual({
      type: "conflict-worker",
      pr: 50,
      ticket: 5,
      headRef: "border-collie/ticket-5-attempt-1",
    });
    const runs = dockerRuns(calls);
    expect(runs).toHaveLength(1);
    const run = runs[0] ?? [];
    expect(run).toContain("--detach");
    expect(run).toContain("sh.border-collie.repository=acme/widgets");
    expect(run).toContain("sh.border-collie.pr=50");
    expect(run).toContain("sh.border-collie.kind=conflict");
    expect(run).toContain("GH_TOKEN=ghs_token");
    expect(run.at(-1)).toContain("border-collie conflict-worker");
    expect(run.at(-1)).toContain("--in-place");
    // Never the synchronous in-process path: no worktree, no claude spawn.
    expect(calls.some((c) => c[0] === "git")).toBe(false);
  });

  it("skips a conflicted PR whose Conflict Worker container is still running", async () => {
    const { exec, calls } = fakeExec({
      prList: [prItem({ mergeable: "CONFLICTING" })],
      dockerPs:
        "sh.border-collie.repository=acme/widgets,sh.border-collie.pr=50,sh.border-collie.kind=conflict",
    });

    const result = await runTick(exec);

    expect(result.world.openAgentPrs[0]?.conflictWorkerLive).toBe(true);
    expect(result.actions.some((a) => a.type === "conflict-worker")).toBe(
      false,
    );
    expect(dockerRuns(calls)).toHaveLength(0);
  });

  it("dispatches a Refinement round into a PR-labelled session container after posting the round marker", async () => {
    const { exec, calls } = fakeExec({
      prList: [
        prItem({
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      ],
    });

    const result = await runTick(exec);

    expect(result.actions).toContainEqual({
      type: "refine-pr",
      pr: 50,
      ticket: 5,
      headRef: "border-collie/ticket-5-attempt-1",
      round: 1,
    });
    const marker = calls.findIndex(
      (c) => c[0] === "gh" && c[1] === "pr" && c[2] === "comment",
    );
    const runs = dockerRuns(calls);
    expect(runs).toHaveLength(1);
    const run = runs[0] ?? [];
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(calls.indexOf(run));
    expect(run).toContain("--detach");
    expect(run).toContain("sh.border-collie.pr=50");
    expect(run).toContain("sh.border-collie.kind=refinement");
    expect(run).toContain("ROUND=1");
    expect(run.at(-1)).toContain("border-collie refine");
    expect(run.at(-1)).toContain("--in-place");
    expect(calls.some((c) => c[0] === "git")).toBe(false);
  });
});
