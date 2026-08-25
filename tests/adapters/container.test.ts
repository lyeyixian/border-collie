import { describe, expect, it } from "vitest";
import {
  type ContainerWorkerConfig,
  dispatchContainerWorker,
  liveContainerTickets,
} from "../../src/adapters/container.js";
import type { Exec } from "../../src/adapters/tracker.js";
import { encodeSessionLabels } from "../../src/core/container.js";

const REPOSITORY = "acme/widgets";

const CONFIG: ContainerWorkerConfig = {
  image: "ghcr.io/acme/border-collie-base:latest",
  timeoutMinutes: 45,
  ghToken: "gh-secret",
  claudeCodeOAuthToken: "claude-secret",
};

function fakeExec(stdout = ""): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return stdout;
  };
  return { exec, calls };
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

    const result = await dispatchContainerWorker(
      7,
      2,
      REPOSITORY,
      CONFIG,
      exec,
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
        CONFIG.image,
        "sh",
        "-c",
        'gh repo clone "$REPOSITORY" . && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"',
      ],
    ]);
  });

  it("never interpolates a dynamic value into the shell script body — everything dynamic rides in as an environment variable", async () => {
    const { exec, calls } = fakeExec();

    await dispatchContainerWorker(7, 2, "acme/widgets; rm -rf /", CONFIG, exec);

    const script = calls[0]?.at(-1);
    expect(script).not.toContain("rm -rf");
    expect(script).toBe(
      'gh repo clone "$REPOSITORY" . && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"',
    );
  });

  it("never waits for the container: the dispatching exec call resolves as soon as docker run hands back", async () => {
    const { exec } = fakeExec("abc123containerid\n");

    await expect(
      dispatchContainerWorker(7, 2, REPOSITORY, CONFIG, exec),
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
