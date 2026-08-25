import {
  type Breaker,
  breakerCooldownMs,
  probeDue,
  tripBreaker,
} from "../core/breaker.js";
import {
  dueRepositories,
  EMPTY_FLEET,
  type FleetSnapshot,
  finishTicking,
  reconcileFleet,
  startTicking,
} from "../core/fleet.js";
import type { Log } from "../core/log.js";
import type { TickResult } from "./tick.js";

/**
 * The daemon (ADR 0009, CONTEXT.md "Daemon"): walks the fleet on an
 * interval and runs one Tick per repository due, each with its own
 * repository-scoped token, in place of the two triggers GitHub Actions
 * provided — the cron backstop becomes this poll, and the Actions
 * concurrency group becomes the per-repository lock `core/fleet.ts` holds
 * as data. `tick` (this module's one required effect beyond the fleet
 * read and token mint) is the same single-repository one-shot the `tick`
 * command already runs; the daemon only decides *when* and *for which
 * repository* to run it, never how.
 */

/** The daemon's effects, injectable for tests, matching the run loop's pattern (`RunDeps`, `app/run.ts`). */
export interface DaemonDeps {
  /** Reads the fleet fresh from the GitHub App installation (CONTEXT.md "Fleet") — never a list this loop keeps itself. */
  listFleet: () => Promise<string[]>;
  /** Mints a token scoped to exactly this repository (ADR 0009), for the one Tick about to run against it. */
  mintToken: (repository: string) => Promise<string>;
  /** One Tick against one repository, using the token just minted for it. */
  tick: (
    repository: string,
    token: string,
    dispatchPaused: boolean,
  ) => Promise<TickResult>;
  /** The circuit breaker's recovery probe — shared across every repository, since an infrastructure failure is an account-wide condition, not a per-repository one. */
  probe: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Log;
  /** Seconds between polls, and the round-robin interval a repository must idle before it is due again. */
  pollSeconds: number;
}

/**
 * The daemon never returns on its own; the operator's service manager is
 * what stops it (a `SIGTERM`/`SIGINT` the caller wires up, same as any other
 * long-running process). Holds exactly the state ADR 0009 names and no
 * more: one circuit breaker per repository (`breakers`, below — trip count
 * and cooldown timer, precisely `run.ts`'s own in-memory breaker generalised
 * to several repositories) and the fleet snapshot's own scheduling data
 * (`core/fleet.ts` — round-robin ordering and the per-repository lock).
 * Fleet membership and Worker liveness are never cached here: the former is
 * re-read from `listFleet` every poll, the latter is the `tick` effect's own
 * concern (container labels, `adapters/container.ts`), read fresh every
 * Tick.
 */
export async function daemon(deps: DaemonDeps): Promise<never> {
  let snapshot: FleetSnapshot = EMPTY_FLEET;
  const breakers = new Map<string, Breaker>();

  /**
   * One repository's whole pass: mint its token, probe recovery if its
   * breaker's cooldown has elapsed, run its Tick, then fold the outcome
   * back into that repository's own breaker — mirroring `run.ts`'s
   * trip/probe sequence exactly, just keyed by repository instead of held
   * for the one repository a resident loop ever knew. Never throws: a
   * repository this pass cannot reach is reported and skipped, leaving
   * every other repository's Tick this poll unaffected, and always
   * releases the per-repository lock in `finally` so a repository that
   * failed is still due again next poll.
   */
  async function tickRepository(repository: string): Promise<void> {
    const repoLog = deps.log.child({ repository });
    try {
      let breaker = breakers.get(repository);
      if (breaker !== undefined && probeDue(breaker, deps.now())) {
        if (await deps.probe()) {
          breaker = undefined;
          breakers.delete(repository);
          repoLog({
            kind: "breaker-closed",
            level: "info",
            msg: `${repository}: circuit breaker closed: the environment recovered — dispatch resumes.`,
          });
        } else {
          breaker = tripBreaker(breaker, deps.now());
          breakers.set(repository, breaker);
          const nextProbeMs = breakerCooldownMs(breaker.trips);
          repoLog({
            kind: "breaker-still-open",
            level: "warn",
            msg: `${repository}: circuit breaker still open: the probe failed — next probe in ${Math.round(nextProbeMs / 60_000)}m.`,
            trips: breaker.trips,
            nextProbeMs,
          });
        }
      }
      const token = await deps.mintToken(repository);
      const result = await deps.tick(repository, token, breaker !== undefined);
      if (result.infraFailures > 0) {
        const tripped = tripBreaker(breaker, deps.now());
        breakers.set(repository, tripped);
        const nextProbeMs = breakerCooldownMs(tripped.trips);
        repoLog({
          kind: "breaker-open",
          level: "warn",
          msg: `${repository}: circuit breaker open: ${result.infraFailures} infrastructure failure${result.infraFailures === 1 ? "" : "s"} this Tick — dispatch paused, claims held, probing in ${Math.round(nextProbeMs / 60_000)}m.`,
          infraFailures: result.infraFailures,
          nextProbeMs,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      repoLog({
        kind: "daemon-repository-unreachable",
        level: "error",
        msg: `${repository}: unreachable this poll (${reason}) — skipped, the rest of the fleet still ticks`,
        reason,
      });
    } finally {
      snapshot = finishTicking(snapshot, repository, deps.now());
    }
  }

  for (;;) {
    try {
      const repositories = await deps.listFleet();
      snapshot = reconcileFleet(snapshot, repositories);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.log({
        kind: "daemon-fleet-unreachable",
        level: "error",
        msg: `could not list the fleet this poll (${reason}) — retrying next poll`,
        reason,
      });
      await deps.sleep(deps.pollSeconds * 1000);
      continue;
    }

    const pollIntervalMs = deps.pollSeconds * 1000;
    const due = dueRepositories(snapshot, pollIntervalMs, deps.now());
    for (const repository of due) {
      snapshot = startTicking(snapshot, repository);
      // Fire-and-forget: this repository's Tick runs concurrently with every
      // other due repository's, and with the poll loop's own sleep below —
      // one repository's slow Tick must never delay another's, or the next
      // poll's own fleet read.
      void tickRepository(repository);
    }

    await deps.sleep(pollIntervalMs);
  }
}
