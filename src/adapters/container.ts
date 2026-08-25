import {
  encodeSessionLabels,
  parseSessionLabels,
  REPOSITORY_LABEL,
  type SessionLabels,
} from "../core/container.js";
import { type Exec, realExec } from "./tracker.js";

/**
 * The session-container seam (issue #177): a Worker Attempt run detached in
 * its own container instead of a GitHub Actions job, the second implementation
 * behind the `DispatchWorker` seam (act.ts) alongside `dispatchRemoteWorker`
 * (this file's sibling, adapters/worker.ts) — added beside it, not replacing
 * it; the Actions path stays the default until the cutover (issue #176).
 * Everything here goes through the `docker` CLI via the injected `Exec` seam,
 * the same shape every `gh`/`git` call in this codebase already takes.
 */

/**
 * What a session container needs to run one Worker Attempt to completion.
 * `image` is never resolved here — the caller names it, the border-collie
 * base image today (issue #177's own scope: "Repository-specific images
 * come later") or a repository's own built image once issue #180 lands, the
 * same way `WorkerConfig.model` (adapters/worker.ts) is resolved by the
 * caller rather than this seam. `ghToken` and `claudeCodeOAuthToken` are the
 * same two credentials the Worker's Actions job already sets as environment
 * (`.github/workflows/border-collie-worker.yml`); minting them is issue
 * #178's concern, not this one's.
 */
export interface ContainerWorkerConfig {
  image: string;
  timeoutMinutes: number;
  ghToken: string;
  claudeCodeOAuthToken: string;
}

/** One session container's `docker run --label key=value` arguments, from its identity. */
function labelArgs(session: SessionLabels): string[] {
  return Object.entries(encodeSessionLabels(session)).flatMap(
    ([key, value]) => ["--label", `${key}=${value}`],
  );
}

/**
 * Dispatch one Worker against one claimed ticket by starting its own session
 * container, detached, and returning immediately without an outcome — the
 * container half of the fire-and-forget dispatch seam (issue #73), alongside
 * `dispatchRemoteWorker`'s Actions-job half (adapters/worker.ts). The
 * container clones the repository fresh (via `gh repo clone`, authenticated
 * by the same token the Worker itself runs under — no checkout is shared
 * with it) and then runs the same Worker entrypoint an Actions job runs
 * today, `--in-place` (issue #75): one container means one checkout with
 * nothing to isolate from or serialize against, exactly like a dedicated job.
 * That entrypoint settles its own Attempt against the tracker (src/app/
 * worker.ts, issue #71); the next Tick reads the result back, and reads this
 * ticket's Worker liveness from the container's own labels
 * (`liveContainerTickets` below) rather than waiting on it here.
 *
 * `--rm`: a session container's transcript is not yet kept on the host
 * (issue #182), so nothing is lost by letting Docker clean up an exited
 * container itself — there is nothing left in it worth inspecting after the
 * tracker write above has landed.
 *
 * The clone-and-run script is a fixed string with every dynamic value
 * carried in through `--env` and read back with `$VAR`, never interpolated
 * into the script body — the same rule the Worker's Actions job's own `run:`
 * step already documents and follows
 * (`.github/workflows/border-collie-worker.yml`: "Dispatch inputs arrive as
 * environment, never interpolated into the script body"), for the same
 * reason: a value spliced straight into a shell string is a command
 * injection waiting on whatever that value turns out to contain.
 */
export async function dispatchContainerWorker(
  ticket: number,
  attempt: number,
  repository: string,
  config: ContainerWorkerConfig,
  exec: Exec = realExec,
): Promise<undefined> {
  await exec("docker", [
    "run",
    "--detach",
    "--rm",
    ...labelArgs({ repository, ticket, attempt }),
    "--env",
    `GH_TOKEN=${config.ghToken}`,
    "--env",
    `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeCodeOAuthToken}`,
    "--env",
    `REPOSITORY=${repository}`,
    "--env",
    `TICKET=${ticket}`,
    "--env",
    `ATTEMPT=${attempt}`,
    "--env",
    `TIMEOUT_MINUTES=${config.timeoutMinutes}`,
    config.image,
    "sh",
    "-c",
    'gh repo clone "$REPOSITORY" . && border-collie worker "$TICKET" "$ATTEMPT" --in-place --timeout-minutes "$TIMEOUT_MINUTES"',
  ]);
  return undefined;
}

/**
 * Ticket numbers with a session container Docker still counts as running,
 * for one repository — the container replacement for `liveWorkerTickets`'s
 * `gh run list` read (adapters/tracker.ts, issue #73), matching its own
 * shape: Worker liveness read from the environment itself rather than a
 * promise held in the Orchestrator's memory, so a restarted Orchestrator
 * reaches the same verdict a long-running one would, and a container that
 * has already exited (`docker ps` lists running containers only, with no
 * `--all`) is never mistaken for one still live.
 */
export async function liveContainerTickets(
  repository: string,
  exec: Exec = realExec,
): Promise<Set<number>> {
  const stdout = await exec("docker", [
    "ps",
    "--filter",
    `label=${REPOSITORY_LABEL}=${repository}`,
    "--format",
    "{{.Labels}}",
  ]);
  const live = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const session = parseSessionLabels(line);
    if (session !== undefined && session.repository === repository) {
      live.add(session.ticket);
    }
  }
  return live;
}
