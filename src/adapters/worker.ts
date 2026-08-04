import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifyInfrastructure,
  lastResultLine,
  parseResultEvent,
} from "../core/classify.js";
import type { Log, LogEvent } from "../core/log.js";
import {
  AGENT_BRANCH_PREFIX,
  type FailureReason,
  type WorkerOutcome,
} from "../core/types.js";
import { type Exec, realExec, WORKER_WORKFLOW_FILE } from "./tracker.js";

/**
 * The WorkerHost seam: everything a dispatched Worker needs around it —
 * worktree, branch, headless `claude -p` process, transcript — composed
 * here, with the subprocess layer injectable for tests. All paths are
 * relative to the target repo root (the orchestrator's cwd).
 */

/** Orchestrator-owned scratch space at the target repo root (gitignored). */
export const RUN_DIR = ".border-collie";

/** The headless-claude run limits shared by dispatch and conflict Workers. */
export interface ClaudeRunConfig {
  /** Model the Worker runs on (`claude --model`). */
  model: string;
  /** Wall-clock ceiling for the whole Worker process. */
  timeoutMs: number;
  /** Max quiet time between output events before the Worker counts as stalled. */
  stallMs: number;
  /** Budget backstop: max agentic turns (`claude --max-turns`); breach is a ticket failure. */
  maxTurns: number;
}

export interface WorkerConfig extends ClaudeRunConfig {
  /**
   * Which Attempt this dispatch is (1-based). Namespaces the branch and
   * transcript so a retry never clobbers the prior attempt's evidence — an
   * Escalation must be able to cite every attempt's forensics.
   */
  attempt: number;
  /**
   * Budget alarm: spend in USD above which an Attempt is flagged as a cost
   * overrun. Cost is only knowable post-hoc, so a finished Attempt's work is
   * kept (discarding it refunds nothing and the retry would cost more) — the
   * turn cap and wall clock are the stoppers, this is the meter.
   */
  maxCostUsd: number;
  /**
   * True for a Worker job that owns its sole checkout (issue #75): the agent
   * branch is checked out directly in the current working directory instead
   * of an isolated worktree, and the repo-level git lock is skipped — one
   * job means one checkout with nothing to isolate from or serialize
   * against. False (the local path's default) keeps today's worktree
   * isolation, which protects the operator's own checkout from a Worker
   * running alongside it.
   */
  inPlace: boolean;
}

/** The headless-claude argv every Worker shares: prompt, model, turn cap, stream-json, skip-permissions. */
function claudeArgs(prompt: string, model: string, maxTurns: number): string[] {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
}

/** What the Worker process is started with. */
export interface WorkerProcessRequest {
  cmd: string;
  args: string[];
  cwd: string;
  /** File the process's stdout (the stream-json events) streams into as it runs. */
  transcriptPath: string;
  /** File the process's stderr streams into, kept apart so the transcript stays parseable. */
  stderrPath: string;
  /** Wall-clock ceiling; the process is killed when it elapses. */
  timeoutMs: number;
  /** Stall window; the process is killed when stdout goes quiet this long. */
  stallMs: number;
  /**
   * Called on every chunk of stdout the process emits — the same
   * observation that re-arms the stall watchdog, surfaced for the fleet
   * heartbeat. No new process seam: this rides the existing one.
   */
  onActivity?: () => void;
}

/** How the Worker process ended: on its own, or killed by which watchdog. */
export interface WorkerProcessExit {
  exitCode: number | null;
  endedBy: "exit" | "timeout" | "stall";
  /** Last stretch of stdout, kept in memory for classification (full stream is on disk). */
  stdoutTail: string;
  /** Last stretch of stderr, kept in memory for classification. */
  stderrTail: string;
}

/** How much of each output stream's tail is kept for classification. */
export const TAIL_LIMIT = 64 * 1024;

/** Accumulate a stream into a bounded tail: only the last TAIL_LIMIT chars survive. */
function makeTail(): {
  push: (chunk: Buffer | string) => void;
  read: () => string;
} {
  let tail = "";
  return {
    push: (chunk) => {
      tail = (tail + String(chunk)).slice(-TAIL_LIMIT);
    },
    read: () => tail,
  };
}

/** Process seam: run the Worker to completion under both watchdogs. */
export type SpawnWorkerProcess = (
  request: WorkerProcessRequest,
) => Promise<WorkerProcessExit>;

export const realSpawnWorkerProcess: SpawnWorkerProcess = (request) =>
  new Promise((resolve, reject) => {
    mkdirSync(dirname(request.transcriptPath), { recursive: true });
    const transcript = createWriteStream(request.transcriptPath);
    const stderr = createWriteStream(request.stderrPath);
    const child = spawn(request.cmd, request.args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutTail = makeTail();
    const stderrTail = makeTail();
    child.stdout.pipe(transcript);
    child.stderr.pipe(stderr);
    child.stdout.on("data", stdoutTail.push);
    child.stderr.on("data", stderrTail.push);

    // SIGKILL, not SIGTERM: a stalled Worker may not be servicing signals.
    let endedBy: WorkerProcessExit["endedBy"] = "exit";
    const wallTimer = setTimeout(() => {
      endedBy = "timeout";
      child.kill("SIGKILL");
    }, request.timeoutMs);
    let stallTimer: NodeJS.Timeout | undefined;
    const rearmStallWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        endedBy = "stall";
        child.kill("SIGKILL");
      }, request.stallMs);
    };
    rearmStallWatchdog();
    child.stdout.on("data", rearmStallWatchdog);
    child.stdout.on("data", () => request.onActivity?.());

    const end = () => {
      clearTimeout(wallTimer);
      clearTimeout(stallTimer);
      transcript.end();
      stderr.end();
    };
    child.on("error", (error) => {
      end();
      reject(error);
    });
    child.on("close", (code) => {
      end();
      resolve({
        exitCode: code,
        endedBy,
        stdoutTail: stdoutTail.read(),
        stderrTail: stderrTail.read(),
      });
    });
  });

/**
 * The entire Worker prompt: the ticket reference, the /implement invocation,
 * and the final-message-is-a-PR-description instruction — nothing else. A
 * Worker is fed nothing beyond its ticket (CONTEXT.md "Worker"); it
 * discovers repo context itself.
 */
export function workerPrompt(ticket: number): string {
  return [
    `/implement issue #${ticket}`,
    "",
    'When the work is committed, make your final message a pull request description for this branch. It is used verbatim as the PR body, so it must contain nothing but the description itself — no preamble like "Here\'s the PR description:", no status narration, no text before or after it.',
  ].join("\n");
}

/**
 * The entire conflict-resolution Worker prompt: finish a rebase the
 * Orchestrator has already started, then stop. Inline rather than delegated to
 * a slash command, so the procedure is versioned and tested with the code
 * rather than with whatever plugin the Worker's environment happens to carry
 * (ADR 0007) — and so the two clauses drawn from measured failure modes can be
 * stated at all: git will happily finish a rebase around a resolution that
 * silently dropped one side, and an agentic loop with no answer in either side
 * iterates until its output merely looks clean. Abstaining needs no plumbing:
 * stopping mid-rebase leaves the branch at its conflicted tip, which the
 * caller already reads as unresolved and hands to a human.
 */
export function conflictWorkerPrompt(ticket: number): string {
  return [
    "A rebase of this pull request's branch onto the base branch is already in progress and has conflicts. Resolve every conflict and continue the rebase until every commit is applied — a rebase, never a merge, so this branch stays linear.",
    "",
    `Before editing a conflicted region, read the primary sources behind both sides rather than the conflicting text alone: the commit messages the two sides came from, this pull request, and the ticket it implements, #${ticket} (\`git log\`, \`gh pr view\`, \`gh issue view ${ticket}\`). Resolve for what each side was trying to do — its intent — not for what makes the markers go away.`,
    "",
    "Both sides' intent must survive the resolution, or the conflict is not resolved. Never drop one side of a conflict to make it disappear — taking one side wholesale, deleting the other side's work, or reverting it is not a resolution.",
    "",
    "Change nothing beyond what resolving the conflicts requires, and do not push — leave the rebase on the current branch, where the Orchestrator will pick it up.",
    "",
    "Stop rather than guess. If resolving a conflict needs information present in neither side, leave the rebase where it stands, unfinished, and stop: an unresolved conflict is handed to a human, which is the right outcome. A guessed resolution is not.",
  ].join("\n");
}

/**
 * The entire Refinement-round Worker prompt (CONTEXT.md "Refinement round"):
 * investigate the pull request's own failing checks and review feedback,
 * then commit a fix. Pins the do-not-push contract the Orchestrator relies on —
 * the Orchestrator judges whether anything changed and pushes it back
 * itself, the same split as the conflict-resolution Worker.
 */
export function refinementWorkerPrompt(): string {
  return [
    "This pull request has a failing check or open review feedback. Look at its CI check runs and its review comments (for example `gh pr checks` and `gh pr view --comments`) to find what needs to change, then commit a fix addressing them. Change nothing beyond what the checks or the reviewer's feedback requires, and do not push — leave the fix committed on the current branch.",
  ].join("\n");
}

/** Best-effort worktree removal: absent or stale worktrees are fine. */
async function removeWorktree(worktree: string, exec: Exec): Promise<void> {
  await exec("git", ["worktree", "remove", "--force", worktree]).catch(
    () => {},
  );
}

/**
 * git worktree and ref operations take repo-level locks, so concurrent
 * Workers must not run them at once. Every git phase takes a turn on this
 * queue; only the long-running claude processes overlap.
 */
let gitTurn: Promise<unknown> = Promise.resolve();
function withGitLock<T>(operation: () => Promise<T>): Promise<T> {
  const turn = gitTurn.then(operation, operation);
  gitTurn = turn.catch(() => {});
  return turn;
}

/**
 * Push an agent branch to origin so a PR can be opened on it. Force, because
 * `-B` resets the branch each attempt: whatever a crashed run left on the
 * remote is superseded, never recorded progress (ADR 0001). Only ever called
 * on agent-prefixed branches.
 */
export async function pushAgentBranch(
  branch: string,
  exec: Exec = realExec,
): Promise<void> {
  await withGitLock(() => exec("git", ["push", "--force", "origin", branch]));
}

/** Commit subjects of an Attempt's work, oldest first. */
export async function branchCommitSubjects(
  base: string,
  branch: string,
  exec: Exec = realExec,
): Promise<string[]> {
  const stdout = await withGitLock(() =>
    exec("git", ["log", "--format=%s", "--reverse", `${base}..${branch}`]),
  );
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Dispatch one Worker against one claimed ticket: cut an agent branch, run
 * headless claude on it streaming to a transcript, then judge the outcome.
 * The branch is cut from the remote default branch's current tip (fetched
 * fresh each dispatch), never the local checkout: a ticket is Dispatchable
 * only once its blockers' PRs have merged, and that gating holds only if the
 * Worker's base contains those merges — the local checkout goes stale the
 * moment a sibling merges mid-run. Branch and transcript are namespaced per
 * attempt so a retry leaves the failed attempt's evidence intact for
 * Escalation. `-B` and the up-front reset (a stale worktree removed, or a
 * plain branch overwritten) discard leftovers of the SAME attempt from a
 * crashed run — a local branch that never became a PR is not recorded
 * progress (ADR 0001: GitHub is the only state store), so re-running the
 * Tick supersedes it.
 *
 * `config.inPlace` picks which of two isolation strategies runs: the local
 * path (default) cuts an isolated worktree so a Worker never touches the
 * operator's own checkout, locking every git phase against sibling Workers'
 * worktree/ref operations (the repo-level lock below); a Worker job (issue
 * #75) owns its sole checkout instead, so it checks the branch out directly
 * in the current working directory and skips both the worktree and the
 * lock — nothing else is running in that checkout to isolate from or
 * serialize against.
 */
/** No-op default for the optional `log` parameter, so every existing caller need not pass one. */
const noopLog: Log = ((_event: LogEvent) => {}) as Log;
noopLog.child = () => noopLog;

export async function dispatchWorker(
  ticket: number,
  config: WorkerConfig,
  exec: Exec = realExec,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
  log: Log = noopLog,
  /** Forwarded onto the process request; the fleet heartbeat's activity signal. */
  onActivity: () => void = () => {},
): Promise<WorkerOutcome> {
  const branch = `${AGENT_BRANCH_PREFIX}${ticket}-attempt-${config.attempt}`;
  const worktree = join(RUN_DIR, "worktrees", `ticket-${ticket}`);
  const cwd = config.inPlace ? "." : worktree;
  const transcript = join(
    RUN_DIR,
    "transcripts",
    `ticket-${ticket}-attempt-${config.attempt}.jsonl`,
  );
  const stderrLog = join(
    RUN_DIR,
    "transcripts",
    `ticket-${ticket}-attempt-${config.attempt}.stderr.log`,
  );

  // A no-op stand-in for withGitLock when there is no sibling Worker to
  // serialize against — the git lock itself must never run on this path.
  const gitPhase = config.inPlace
    ? <T>(operation: () => Promise<T>): Promise<T> => operation()
    : withGitLock;

  const base = await gitPhase(async () => {
    if (config.inPlace) {
      await exec("git", ["fetch", "origin"]);
      await exec("git", ["checkout", "-B", branch, "origin/HEAD"]);
    } else {
      await removeWorktree(worktree, exec);
      await exec("git", ["worktree", "prune"]);
      await exec("git", ["fetch", "origin"]);
      await exec("git", [
        "worktree",
        "add",
        worktree,
        "-B",
        branch,
        "origin/HEAD",
      ]);
    }
    return (await exec("git", ["rev-parse", branch])).trim();
  });
  // Logged once the checkout actually exists, so an operator can find a
  // Worker's evidence — the checkout while it runs, the transcript any time
  // after — without deriving the paths by hand.
  log({
    kind: "worker-paths",
    level: "debug",
    msg: `Worker for #${ticket} (attempt ${config.attempt}): ${config.inPlace ? "checkout" : "worktree"} ${cwd}, transcript ${transcript}`,
    ticket,
    attempt: config.attempt,
    path: cwd,
    transcript,
  });

  try {
    // Headless Workers cannot answer permission prompts; skipping them is
    // what confines the blast radius to the checkout plus the operator's
    // own tracker.
    const { exitCode, endedBy, stdoutTail, stderrTail } = await spawnProcess({
      cmd: "claude",
      args: claudeArgs(workerPrompt(ticket), config.model, config.maxTurns),
      cwd,
      transcriptPath: transcript,
      stderrPath: stderrLog,
      timeoutMs: config.timeoutMs,
      stallMs: config.stallMs,
      onActivity,
    });
    const newCommits = Number(
      (
        await gitPhase(() =>
          exec("git", ["rev-list", "--count", `${base}..${branch}`]),
        )
      ).trim(),
    );
    // A killed Worker fails even with commits on the branch: it never got to
    // finish, so the work is unverified and the PR description is missing.
    const trigger: FailureReason | undefined =
      endedBy !== "exit"
        ? endedBy
        : exitCode !== 0
          ? "nonzero-exit"
          : newCommits === 0
            ? "no-commits"
            : undefined;
    const result = parseResultEvent(stdoutTail);
    // Classification order: turn cap trumps infra trumps the raw trigger. A
    // parsed result event proves the environment carried the Worker to its
    // end, so a turn-cap halt is the ticket's fault whatever infra-looking
    // noise the logs hold — and it fails even on a clean exit with commits:
    // a halted Worker never finished, so the work is unverified. The cost
    // cap is different in kind: cost is only knowable post-hoc from the
    // result event, so it cannot stop anything — a finished Attempt's work
    // is kept (discarding it refunds nothing and the retry would cost more)
    // and the overrun is flagged instead. Infra is only consulted for
    // Workers that already died — a successful Attempt is never voided —
    // and only against stderr plus the result line, never the transcript
    // body, where a ticket legitimately about rate limits would match by
    // content instead of cause.
    const turnCapHit = result?.subtype === "error_max_turns";
    const infra =
      trigger !== undefined && !turnCapHit
        ? classifyInfrastructure(`${stderrTail}\n${lastResultLine(stdoutTail)}`)
        : undefined;
    const failure: FailureReason | undefined = turnCapHit
      ? "budget"
      : infra !== undefined
        ? undefined
        : trigger;
    return {
      ticket,
      attempt: config.attempt,
      branch,
      base,
      transcript,
      model: config.model,
      exitCode,
      newCommits,
      failure,
      infra,
      costUsd: result?.totalCostUsd,
      turns: result?.numTurns,
      durationMs: result?.durationMs,
      subtype: result?.subtype,
      costOverrun:
        result?.totalCostUsd !== undefined &&
        result.totalCostUsd > config.maxCostUsd,
      ok: failure === undefined && infra === undefined,
    };
  } finally {
    // Nothing to clean up in-place: the checkout is the job's own, torn down
    // with the runner rather than removed here.
    if (!config.inPlace) {
      await withGitLock(() => removeWorktree(worktree, exec));
    }
  }
}

/**
 * Dispatch one Worker against one claimed ticket by triggering its GitHub
 * Actions job (issue #75) and returning immediately, without an outcome —
 * the fire-and-forget half of the dispatch seam (issue #73), alongside the
 * synchronous `dispatchWorker` above, which the local path keeps unchanged.
 * The job runs the Worker entrypoint command, which settles its own Attempt
 * (src/app/worker.ts, issue #71): opening the draft PR itself on success,
 * releasing with the forensic record on a Ticket failure, or voiding the
 * Attempt on an Infrastructure failure. The next Tick reads the result back
 * from the tracker, and reads the job's own running state as this ticket's
 * Worker liveness (`liveWorkerTickets`, adapters/tracker.ts) rather than
 * waiting on it here. Ticket and attempt are explicit workflow_dispatch
 * inputs — dispatch is never inferred from a label or an assignee event,
 * since the Orchestrator already knows which Ticket it decided to dispatch.
 */
export async function dispatchRemoteWorker(
  ticket: number,
  attempt: number,
  exec: Exec = realExec,
): Promise<undefined> {
  await exec("gh", [
    "workflow",
    "run",
    WORKER_WORKFLOW_FILE,
    "-f",
    `ticket=${ticket}`,
    "-f",
    `attempt=${attempt}`,
  ]);
  return undefined;
}

/** The probe's own generous window: a healthy environment answers in seconds. */
export const PROBE_TIMEOUT_MS = 2 * 60_000;

/**
 * The circuit breaker's recovery probe: one trivial headless prompt, no
 * tracker writes, no worktree. The environment counts as recovered when the
 * probe exits cleanly with no infrastructure signature in its output — only
 * then does dispatch resume.
 */
export async function probeEnvironment(
  model: string,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
): Promise<boolean> {
  const { exitCode, endedBy, stdoutTail, stderrTail } = await spawnProcess({
    cmd: "claude",
    args: ["-p", "Reply with only the word ok.", "--model", model],
    cwd: ".",
    transcriptPath: join(RUN_DIR, "transcripts", "probe.log"),
    stderrPath: join(RUN_DIR, "transcripts", "probe.stderr.log"),
    timeoutMs: PROBE_TIMEOUT_MS,
    stallMs: PROBE_TIMEOUT_MS,
  }).catch(() => ({
    // A probe that cannot even spawn is a failed probe, not a crashed run.
    exitCode: null,
    endedBy: "exit" as const,
    stdoutTail: "",
    stderrTail: "spawn failed",
  }));
  return (
    endedBy === "exit" &&
    exitCode === 0 &&
    classifyInfrastructure(`${stderrTail}\n${stdoutTail}`) === undefined
  );
}

/** What a conflict-resolution Worker runs with; no attempt ladder — one shot. */
export type ConflictWorkerConfig = ClaudeRunConfig;

/** One finished conflict-resolution session, as observed by the Orchestrator. */
export interface ConflictOutcome {
  pr: number;
  ticket: number;
  /** Head branch the Worker resolved in; pushed back on success. */
  headRef: string;
  /** Transcript file path, for post-mortems. */
  transcript: string;
  exitCode: number | null;
  /**
   * True when the branch is fully rebased onto the base: the Worker exited on
   * its own and the branch ref now contains origin/HEAD. Containment is the
   * whole test — git moves the branch ref only when a rebase runs to
   * completion, so a rebase left mid-flight (or never started, e.g. the base
   * ref could not be read) leaves the branch at its conflicted old tip, which
   * predates the base. Deliberately NOT probed via REBASE_HEAD: git leaves
   * that ref behind after a successful `rebase --continue`, which read a
   * finished rebase as still-in-progress (a false failure).
   */
  resolved: boolean;
}

/**
 * Dispatch one conflict-resolution Worker against one conflicted agent PR: cut
 * a worktree on the PR's own head branch, start the rebase onto the base so
 * the Worker has an in-progress conflict to resolve, run headless claude, then
 * judge whether the rebase completed. A rebase, never a
 * merge commit: the branch stays linear, so the operator's "Rebase and merge"
 * strategy keeps working (a resolution recorded in a merge commit is dropped
 * when that strategy replays the branch's commits, re-conflicting them). The
 * branch is the PR's existing head (checked out from origin), never a fresh
 * one — the resolution has to force-push back to the same branch the PR is
 * opened from. `-B` and the up-front removal reset any leftover of a crashed
 * run on the same branch. On success the caller pushes the branch; on failure
 * the rebase is aborted so the retained branch stays at the PR's committed
 * head — a broken rebase is never published — and the caller asks a human to
 * take over.
 */
export async function dispatchConflictWorker(
  pr: number,
  ticket: number,
  headRef: string,
  config: ConflictWorkerConfig,
  exec: Exec = realExec,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
  log: Log = noopLog,
): Promise<ConflictOutcome> {
  const worktree = join(RUN_DIR, "conflict-worktrees", `pr-${pr}`);
  const transcript = join(RUN_DIR, "transcripts", `pr-${pr}-conflict.jsonl`);
  const stderrLog = join(
    RUN_DIR,
    "transcripts",
    `pr-${pr}-conflict.stderr.log`,
  );

  await withGitLock(async () => {
    await removeWorktree(worktree, exec);
    await exec("git", ["worktree", "prune"]);
    await exec("git", ["fetch", "origin"]);
    await exec("git", [
      "worktree",
      "add",
      worktree,
      "-B",
      headRef,
      `origin/${headRef}`,
    ]);
    // A conflicting rebase exits non-zero and stops in progress for the
    // Worker; swallow that so setting up the conflict never throws.
    await exec("git", ["-C", worktree, "rebase", "origin/HEAD"]).catch(
      () => {},
    );
  });
  log({
    kind: "conflict-worker-paths",
    level: "debug",
    msg: `Conflict Worker for PR #${pr}: worktree ${worktree}, transcript ${transcript}`,
    pr,
    worktree,
    transcript,
  });

  try {
    const { exitCode, endedBy } = await spawnProcess({
      cmd: "claude",
      args: claudeArgs(
        conflictWorkerPrompt(ticket),
        config.model,
        config.maxTurns,
      ),
      cwd: worktree,
      transcriptPath: transcript,
      stderrPath: stderrLog,
      timeoutMs: config.timeoutMs,
      stallMs: config.stallMs,
    });
    // The branch ref, not HEAD: mid-rebase HEAD is detached on the commit
    // being replayed, while the branch only moves on completion.
    const rebased = await withGitLock(() =>
      exec("git", [
        "-C",
        worktree,
        "merge-base",
        "--is-ancestor",
        "origin/HEAD",
        headRef,
      ]).then(
        () => true,
        () => false,
      ),
    );
    const resolved = endedBy === "exit" && exitCode === 0 && rebased;
    return { pr, ticket, headRef, transcript, exitCode, resolved };
  } finally {
    // Abort any half-finished rebase before dropping the worktree; a no-op
    // when the Worker already completed the rebase.
    await withGitLock(async () => {
      await exec("git", ["-C", worktree, "rebase", "--abort"]).catch(() => {});
      await removeWorktree(worktree, exec);
    });
  }
}

/** One finished Refinement-round Worker session, as observed by the Orchestrator. */
export interface RefinementOutcome {
  pr: number;
  ticket: number;
  /** Head branch the Worker ran in; pushed back by the caller when it committed something. */
  headRef: string;
  /** Transcript file path, for post-mortems — namespaced per round, so a later round never clobbers an earlier one's evidence. */
  transcript: string;
  exitCode: number | null;
  /** Commits the Worker added on top of the branch's tip when it started. */
  newCommits: number;
}

/**
 * Dispatch one Refinement-round Worker against one open agent PR (CONTEXT.md
 * "Refinement round"): cut a worktree on the PR's own head branch (no rebase
 * setup — a round investigates the PR as it stands, unlike the conflict
 * Worker), run headless claude in it, then report whether it committed
 * anything. The branch is the PR's existing head (checked out from origin),
 * never a fresh one — a pushed fix has to land on the same branch the PR is
 * already open from. `-B` and the up-front removal reset any leftover of a
 * crashed round on the same branch. The Worker never pushes (the prompt
 * pins that contract); the caller judges `newCommits` and pushes only when
 * the round actually changed something, mirroring the conflict Worker's own
 * split between judging and pushing.
 */
export async function dispatchRefinementWorker(
  pr: number,
  ticket: number,
  headRef: string,
  round: number,
  config: ClaudeRunConfig,
  exec: Exec = realExec,
  spawnProcess: SpawnWorkerProcess = realSpawnWorkerProcess,
  log: Log = noopLog,
): Promise<RefinementOutcome> {
  const worktree = join(RUN_DIR, "refinement-worktrees", `pr-${pr}`);
  const transcript = join(
    RUN_DIR,
    "transcripts",
    `pr-${pr}-refinement-round-${round}.jsonl`,
  );
  const stderrLog = join(
    RUN_DIR,
    "transcripts",
    `pr-${pr}-refinement-round-${round}.stderr.log`,
  );

  const base = await withGitLock(async () => {
    await removeWorktree(worktree, exec);
    await exec("git", ["worktree", "prune"]);
    await exec("git", ["fetch", "origin"]);
    await exec("git", [
      "worktree",
      "add",
      worktree,
      "-B",
      headRef,
      `origin/${headRef}`,
    ]);
    return (await exec("git", ["rev-parse", headRef])).trim();
  });
  log({
    kind: "refinement-worker-paths",
    level: "debug",
    msg: `Refinement Worker for PR #${pr} (round ${round}): worktree ${worktree}, transcript ${transcript}`,
    pr,
    round,
    worktree,
    transcript,
  });

  try {
    const { exitCode } = await spawnProcess({
      cmd: "claude",
      args: claudeArgs(refinementWorkerPrompt(), config.model, config.maxTurns),
      cwd: worktree,
      transcriptPath: transcript,
      stderrPath: stderrLog,
      timeoutMs: config.timeoutMs,
      stallMs: config.stallMs,
    });
    const newCommits = Number(
      (
        await withGitLock(() =>
          exec("git", ["rev-list", "--count", `${base}..${headRef}`]),
        )
      ).trim(),
    );
    return { pr, ticket, headRef, transcript, exitCode, newCommits };
  } finally {
    await withGitLock(() => removeWorktree(worktree, exec));
  }
}
