/**
 * The daemon's fleet-scheduling seam (issue #183): which repositories are
 * due for a Tick this poll, in what order, and whether one is already
 * ticking — kept separate from the process that acts on it, the same way
 * the dispatch plan (core/plan.ts) and the circuit breaker (core/breaker.ts)
 * already are. Pure state and pure functions only; the daemon (src/app/
 * daemon.ts) is the only caller that performs I/O, reading fleet membership
 * fresh from the GitHub App installation every poll (CONTEXT.md "Fleet")
 * and feeding it through `reconcileFleet` below rather than keeping a list
 * of its own.
 */

export interface FleetMember {
  /** `"owner/name"`, as the GitHub App installation lists it. */
  repository: string;
  /**
   * When this repository's last Tick finished, or undefined if it has never
   * ticked — a never-ticked repository is always due immediately.
   */
  lastTickedAtMs: number | undefined;
  /**
   * True while a Tick for this repository is in flight — the
   * per-repository lock (ADR 0009): two Ticks for one repository must
   * never overlap, so a locked repository is never due no matter how long
   * it has been since its last Tick.
   */
  ticking: boolean;
}

/** The whole fleet's scheduling state, one entry per repository the App is currently installed on. */
export interface FleetSnapshot {
  members: readonly FleetMember[];
}

/** The starting state before a daemon's first poll has ever read the fleet. */
export const EMPTY_FLEET: FleetSnapshot = { members: [] };

/**
 * Reconciles a fresh fleet membership list — read from the App installation
 * every poll, never a list border-collie stores itself (CONTEXT.md "Fleet")
 * — against the previous snapshot's scheduling state: a repository already
 * known keeps its lock and last-ticked timestamp, a newly installed
 * repository joins never-ticked (due immediately), and a repository the App
 * is no longer installed on drops out entirely. Installing the App is how
 * the operator adds a repository to the fleet and uninstalling is how they
 * remove one — there is no second list to drift out of sync.
 */
export function reconcileFleet(
  previous: FleetSnapshot,
  repositories: readonly string[],
): FleetSnapshot {
  const known = new Map(previous.members.map((m) => [m.repository, m]));
  return {
    members: repositories.map(
      (repository): FleetMember =>
        known.get(repository) ?? {
          repository,
          lastTickedAtMs: undefined,
          ticking: false,
        },
    ),
  };
}

/**
 * Repositories due for a Tick this poll: not currently ticking (the
 * per-repository lock), and either never ticked or idle at least
 * `pollIntervalMs` — ordered oldest-ticked-first, a never-ticked repository
 * sorting ahead of every already-ticked one, ties broken by repository name
 * for a stable order across polls that find nothing new due. This is the
 * round-robin: a repository just ticked moves to the back of the queue, so
 * one repository with a long queue of its own Tickets cannot monopolise the
 * loop — the daemon fires at most one Tick per repository per poll
 * regardless of how much work that Tick finds.
 */
export function dueRepositories(
  snapshot: FleetSnapshot,
  pollIntervalMs: number,
  nowMs: number,
): string[] {
  return snapshot.members
    .filter(
      (member) =>
        !member.ticking &&
        (member.lastTickedAtMs === undefined ||
          nowMs - member.lastTickedAtMs >= pollIntervalMs),
    )
    .sort((a, b) => {
      const aMs = a.lastTickedAtMs ?? Number.NEGATIVE_INFINITY;
      const bMs = b.lastTickedAtMs ?? Number.NEGATIVE_INFINITY;
      return aMs !== bMs ? aMs - bMs : a.repository.localeCompare(b.repository);
    })
    .map((member) => member.repository);
}

/**
 * Engages a repository's per-repository lock: a Tick for it is now in
 * flight, so it drops out of `dueRepositories` until `finishTicking`
 * releases it — the mechanism that keeps two Ticks for one repository from
 * ever overlapping. A no-op (returns `snapshot` unchanged in shape) if
 * `repository` is not a current member, which cannot happen through the
 * daemon's own loop since it only locks repositories `dueRepositories` just
 * returned.
 */
export function startTicking(
  snapshot: FleetSnapshot,
  repository: string,
): FleetSnapshot {
  return {
    members: snapshot.members.map((member) =>
      member.repository === repository ? { ...member, ticking: true } : member,
    ),
  };
}

/**
 * Releases a repository's per-repository lock once its Tick has settled —
 * successfully or not, the caller always calls this — recording when: the
 * round-robin clock the next poll's `dueRepositories` ordering reads.
 */
export function finishTicking(
  snapshot: FleetSnapshot,
  repository: string,
  finishedAtMs: number,
): FleetSnapshot {
  return {
    members: snapshot.members.map((member) =>
      member.repository === repository
        ? { ...member, ticking: false, lastTickedAtMs: finishedAtMs }
        : member,
    ),
  };
}
