import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContainerWorkerConfig,
  dispatchContainerWorker,
  type EnsureDir,
  type ListTranscripts,
  liveContainerTickets,
  pruneTranscripts,
  type RemoveTranscript,
  realEnsureDir,
  realListTranscripts,
  realRemoveTranscript,
} from "../../src/adapters/container.js";
import type { Exec } from "../../src/adapters/tracker.js";
import {
  encodeSessionLabels,
  type TranscriptFile,
} from "../../src/core/container.js";

const REPOSITORY = "acme/widgets";
const TRANSCRIPTS_ROOT = "/var/lib/border-collie/transcripts";

const CONFIG: ContainerWorkerConfig = {
  image: "ghcr.io/acme/border-collie-base:latest",
  timeoutMinutes: 45,
  ghToken: "gh-secret",
  claudeCodeOAuthToken: "claude-secret",
  transcriptsRoot: TRANSCRIPTS_ROOT,
};

function fakeExec(stdout = ""): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return stdout;
  };
  return { exec, calls };
}

function fakeEnsureDir(): { ensureDir: EnsureDir; calls: string[] } {
  const calls: string[] = [];
  const ensureDir: EnsureDir = async (path) => {
    calls.push(path);
  };
  return { ensureDir, calls };
}

function labelsField(
  repository: string,
  ticket: number,
  attempt: number,
): string {
  return Object.entries(encodeSessionLabels({ repository, ticket, attempt }))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

describe("dispatchContainerWorker", () => {
  it("starts a detached, self-removing container labelled with repository, ticket and attempt, resolving with no outcome", async () => {
    const { exec, calls } = fakeExec();
    const { ensureDir } = fakeEnsureDir();

    const result = await dispatchContainerWorker(
      7,
      2,
      REPOSITORY,
      CONFIG,
      exec,
      ensureDir,
    );

    expect(result).toBeUndefined();
    expect(calls).toEqual([
      [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--label",
        `sh.border-collie.repository=${REPOSITORY}`,
        "--label",
        "sh.border-collie.ticket=7",
        "--label",
        "sh.border-collie.attempt=2",
        "--env",
        "GH_TOKEN=gh-secret",
        "--env",
        "CLAUDE_CODE_OAUTH_TOKEN=claude-secret",
        "--env",
        `REPOSITORY=${REPOSITORY}`,
        "--env",
        "TICKET=7",
        "--env",
        "ATTEMPT=2",
        "--env",
        "TIMEOUT_MINUTES=45",
        "--volume",
        `${TRANSCRIPTS_ROOT}/${REPOSITORY}:/border-collie/transcripts`,
        CONFIG.image,
        "sh",
        "-c",
        'gh repo clone "$REPOSITORY" . && mkdir -p .border-collie && ln -sfn /border-collie/transcripts .border-collie/transcripts && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"',
      ],
    ]);
  });

  it("ensures this repository's host transcript directory exists before starting the container", async () => {
    const { exec } = fakeExec();
    const { ensureDir, calls } = fakeEnsureDir();

    await dispatchContainerWorker(7, 2, REPOSITORY, CONFIG, exec, ensureDir);

    expect(calls).toEqual([`${TRANSCRIPTS_ROOT}/${REPOSITORY}`]);
  });

  it("never interpolates a dynamic value into the shell script body — everything dynamic rides in as an environment variable", async () => {
    const { exec, calls } = fakeExec();
    const { ensureDir } = fakeEnsureDir();

    await dispatchContainerWorker(
      7,
      2,
      "acme/rm-rf-widgets",
      CONFIG,
      exec,
      ensureDir,
    );

    const script = calls[0]?.at(-1);
    expect(script).not.toContain("rm-rf-widgets");
    expect(script).toBe(
      'gh repo clone "$REPOSITORY" . && mkdir -p .border-collie && ln -sfn /border-collie/transcripts .border-collie/transcripts && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"',
    );
  });

  it("rejects a repository that is not a plain owner/repo pair before touching the disk or docker", async () => {
    const { exec, calls } = fakeExec();
    const { ensureDir, calls: dirCalls } = fakeEnsureDir();

    await expect(
      dispatchContainerWorker(
        7,
        2,
        "acme/widgets; rm -rf /",
        CONFIG,
        exec,
        ensureDir,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(dirCalls).toEqual([]);
  });

  it("never waits for the container: the dispatching exec call resolves as soon as docker run hands back", async () => {
    const { exec } = fakeExec("abc123containerid\n");
    const { ensureDir } = fakeEnsureDir();

    await expect(
      dispatchContainerWorker(7, 2, REPOSITORY, CONFIG, exec, ensureDir),
    ).resolves.toBeUndefined();
  });
});

describe("liveContainerTickets", () => {
  it("filters docker ps by this repository's label", async () => {
    const { exec, calls } = fakeExec();

    await liveContainerTickets(REPOSITORY, exec);

    expect(calls).toEqual([
      [
        "docker",
        "ps",
        "--filter",
        `label=sh.border-collie.repository=${REPOSITORY}`,
        "--format",
        "{{.Labels}}",
      ],
    ]);
  });

  it("collects tickets from every running container's labels", async () => {
    const stdout = [
      labelsField(REPOSITORY, 5, 1),
      `com.docker.compose.project=fleet,${labelsField(REPOSITORY, 9, 2)}`,
    ].join("\n");
    const { exec } = fakeExec(stdout);

    expect(await liveContainerTickets(REPOSITORY, exec)).toEqual(
      new Set([5, 9]),
    );
  });

  it("a process that just started reaches the same verdict as one that has been running: presence alone is liveness", async () => {
    const { exec } = fakeExec(labelsField(REPOSITORY, 5, 1));

    expect(await liveContainerTickets(REPOSITORY, exec)).toEqual(new Set([5]));
  });

  it("never counts a container docker did not list as live (an exited one is simply absent)", async () => {
    const { exec } = fakeExec("");

    expect(await liveContainerTickets(REPOSITORY, exec)).toEqual(new Set());
  });

  it("ignores a container whose labels do not parse", async () => {
    const { exec } = fakeExec("com.docker.compose.project=fleet");

    expect(await liveContainerTickets(REPOSITORY, exec)).toEqual(new Set());
  });

  it("ignores a container labelled for a different repository", async () => {
    const { exec } = fakeExec(labelsField("other/repo", 5, 1));

    expect(await liveContainerTickets(REPOSITORY, exec)).toEqual(new Set());
  });
});

function fakeListTranscripts(files: TranscriptFile[]): {
  listTranscripts: ListTranscripts;
  calls: string[];
} {
  const calls: string[] = [];
  const listTranscripts: ListTranscripts = async (dir) => {
    calls.push(dir);
    return files;
  };
  return { listTranscripts, calls };
}

function fakeRemoveTranscript(): {
  removeTranscript: RemoveTranscript;
  calls: string[];
} {
  const calls: string[] = [];
  const removeTranscript: RemoveTranscript = async (path) => {
    calls.push(path);
  };
  return { removeTranscript, calls };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 30 * DAY;

describe("pruneTranscripts", () => {
  it("lists this repository's host transcript directory and asks Docker which tickets are still live", async () => {
    const { exec, calls: execCalls } = fakeExec(labelsField(REPOSITORY, 9, 1));
    const { listTranscripts, calls: dirCalls } = fakeListTranscripts([]);
    const { removeTranscript } = fakeRemoveTranscript();

    await pruneTranscripts(
      REPOSITORY,
      TRANSCRIPTS_ROOT,
      14 * DAY,
      exec,
      listTranscripts,
      removeTranscript,
      NOW,
    );

    expect(dirCalls).toEqual([`${TRANSCRIPTS_ROOT}/${REPOSITORY}`]);
    expect(execCalls).toEqual([
      [
        "docker",
        "ps",
        "--filter",
        `label=sh.border-collie.repository=${REPOSITORY}`,
        "--format",
        "{{.Labels}}",
      ],
    ]);
  });

  it("deletes an aged-out transcript and stderr log, keeping a recent one, and returns the removed host paths", async () => {
    const { exec } = fakeExec();
    const { listTranscripts } = fakeListTranscripts([
      { name: "ticket-1-attempt-1.jsonl", mtimeMs: NOW - 20 * DAY },
      { name: "ticket-1-attempt-1.stderr.log", mtimeMs: NOW - 20 * DAY },
      { name: "ticket-2-attempt-1.jsonl", mtimeMs: NOW - DAY },
    ]);
    const { removeTranscript, calls } = fakeRemoveTranscript();

    const removed = await pruneTranscripts(
      REPOSITORY,
      TRANSCRIPTS_ROOT,
      14 * DAY,
      exec,
      listTranscripts,
      removeTranscript,
      NOW,
    );

    const dir = `${TRANSCRIPTS_ROOT}/${REPOSITORY}`;
    expect(calls).toEqual([
      `${dir}/ticket-1-attempt-1.jsonl`,
      `${dir}/ticket-1-attempt-1.stderr.log`,
    ]);
    expect(removed).toEqual(calls);
  });

  it("never deletes a transcript for a Ticket still running, however old", async () => {
    const { exec } = fakeExec(labelsField(REPOSITORY, 1, 1));
    const { listTranscripts } = fakeListTranscripts([
      { name: "ticket-1-attempt-1.jsonl", mtimeMs: NOW - 30 * DAY },
    ]);
    const { removeTranscript, calls } = fakeRemoveTranscript();

    await pruneTranscripts(
      REPOSITORY,
      TRANSCRIPTS_ROOT,
      14 * DAY,
      exec,
      listTranscripts,
      removeTranscript,
      NOW,
    );

    expect(calls).toEqual([]);
  });
});

describe("realListTranscripts / realRemoveTranscript / realEnsureDir", () => {
  it("lists nothing for a repository with no transcript directory yet, rather than failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "border-collie-test-"));

    expect(await realListTranscripts(join(root, "never-created"))).toEqual([]);
  });

  it("creates the directory, lists what real files it holds with their mtime, and deletes on request", async () => {
    const root = mkdtempSync(join(tmpdir(), "border-collie-test-"));
    const dir = join(root, "acme", "widgets");

    await realEnsureDir(dir);
    expect(existsSync(dir)).toBe(true);

    const filePath = join(dir, "ticket-1-attempt-1.jsonl");
    writeFileSync(filePath, "{}");
    const oldMtime = new Date(Date.now() - 20 * DAY);
    utimesSync(filePath, oldMtime, oldMtime);

    const files = await realListTranscripts(dir);
    expect(files).toEqual([
      { name: "ticket-1-attempt-1.jsonl", mtimeMs: oldMtime.getTime() },
    ]);

    await realRemoveTranscript(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  it("prunes real files on real disk end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "border-collie-test-"));
    const dir = join(root, REPOSITORY);
    await realEnsureDir(dir);

    const stale = join(dir, "ticket-1-attempt-1.jsonl");
    const fresh = join(dir, "ticket-2-attempt-1.jsonl");
    writeFileSync(stale, "{}");
    writeFileSync(fresh, "{}");
    const staleMtime = new Date(Date.now() - 20 * DAY);
    utimesSync(stale, staleMtime, staleMtime);

    const { exec } = fakeExec();

    const removed = await pruneTranscripts(
      REPOSITORY,
      root,
      14 * DAY,
      exec,
      realListTranscripts,
      realRemoveTranscript,
    );

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
