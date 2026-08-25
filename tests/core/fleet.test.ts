import { describe, expect, it } from "vitest";
import {
  dueRepositories,
  EMPTY_FLEET,
  type FleetSnapshot,
  finishTicking,
  reconcileFleet,
  startTicking,
} from "../../src/core/fleet.js";

function snapshotOf(
  members: {
    repository: string;
    lastTickedAtMs?: number | undefined;
    ticking?: boolean;
  }[],
): FleetSnapshot {
  return {
    members: members.map((m) => ({
      repository: m.repository,
      lastTickedAtMs: m.lastTickedAtMs,
      ticking: m.ticking ?? false,
    })),
  };
}

describe("reconcileFleet", () => {
  it("adds a newly installed repository as never-ticked", () => {
    const next = reconcileFleet(EMPTY_FLEET, ["acme/widget"]);

    expect(next).toEqual(
      snapshotOf([{ repository: "acme/widget", lastTickedAtMs: undefined }]),
    );
  });

  it("preserves an existing member's lock and last-ticked timestamp", () => {
    const previous = snapshotOf([
      { repository: "acme/widget", lastTickedAtMs: 1000, ticking: true },
    ]);

    const next = reconcileFleet(previous, ["acme/widget"]);

    expect(next).toEqual(previous);
  });

  it("drops a repository the App is no longer installed on", () => {
    const previous = snapshotOf([
      { repository: "acme/widget", lastTickedAtMs: 1000 },
      { repository: "acme/gizmo", lastTickedAtMs: 2000 },
    ]);

    const next = reconcileFleet(previous, ["acme/widget"]);

    expect(next).toEqual(
      snapshotOf([{ repository: "acme/widget", lastTickedAtMs: 1000 }]),
    );
  });
});

describe("dueRepositories", () => {
  it("is due immediately for a repository that has never ticked", () => {
    const snapshot = snapshotOf([{ repository: "acme/widget" }]);

    expect(dueRepositories(snapshot, 30_000, 0)).toEqual(["acme/widget"]);
  });

  it("is not due until the poll interval has elapsed since its last Tick", () => {
    const snapshot = snapshotOf([
      { repository: "acme/widget", lastTickedAtMs: 1000 },
    ]);

    expect(dueRepositories(snapshot, 30_000, 20_999)).toEqual([]);
    expect(dueRepositories(snapshot, 30_000, 31_000)).toEqual(["acme/widget"]);
  });

  it("never returns a repository that is currently ticking, however overdue", () => {
    const snapshot = snapshotOf([
      { repository: "acme/widget", lastTickedAtMs: 0, ticking: true },
    ]);

    expect(dueRepositories(snapshot, 30_000, 1_000_000)).toEqual([]);
  });

  it("orders due repositories oldest-ticked-first — the round robin", () => {
    const snapshot = snapshotOf([
      { repository: "acme/newest", lastTickedAtMs: 3000 },
      { repository: "acme/oldest", lastTickedAtMs: 1000 },
      { repository: "acme/middle", lastTickedAtMs: 2000 },
    ]);

    expect(dueRepositories(snapshot, 0, 10_000)).toEqual([
      "acme/oldest",
      "acme/middle",
      "acme/newest",
    ]);
  });

  it("sorts a never-ticked repository ahead of every already-ticked one", () => {
    const snapshot = snapshotOf([
      { repository: "acme/ticked", lastTickedAtMs: 1 },
      { repository: "acme/fresh" },
    ]);

    expect(dueRepositories(snapshot, 0, 10_000)).toEqual([
      "acme/fresh",
      "acme/ticked",
    ]);
  });

  it("breaks ties by repository name for a stable order", () => {
    const snapshot = snapshotOf([
      { repository: "acme/zebra", lastTickedAtMs: 1000 },
      { repository: "acme/apple", lastTickedAtMs: 1000 },
    ]);

    expect(dueRepositories(snapshot, 0, 10_000)).toEqual([
      "acme/apple",
      "acme/zebra",
    ]);
  });

  it("does not let one repository's own overdue backlog crowd out another's due Tick", () => {
    // Both repositories are simultaneously due; a slow or busy repository
    // never prevents a sibling from appearing in this same due list.
    const snapshot = snapshotOf([
      { repository: "acme/busy", lastTickedAtMs: 0 },
      { repository: "acme/quiet", lastTickedAtMs: 0 },
    ]);

    expect(dueRepositories(snapshot, 30_000, 100_000)).toEqual([
      "acme/busy",
      "acme/quiet",
    ]);
  });
});

describe("startTicking / finishTicking", () => {
  it("engages the per-repository lock, removing it from the due list", () => {
    const snapshot = snapshotOf([{ repository: "acme/widget" }]);

    const locked = startTicking(snapshot, "acme/widget");

    expect(dueRepositories(locked, 0, 0)).toEqual([]);
  });

  it("releases the lock and records when the Tick finished", () => {
    const snapshot = startTicking(
      snapshotOf([{ repository: "acme/widget" }]),
      "acme/widget",
    );

    const released = finishTicking(snapshot, "acme/widget", 5000);

    expect(released).toEqual(
      snapshotOf([
        { repository: "acme/widget", lastTickedAtMs: 5000, ticking: false },
      ]),
    );
    expect(dueRepositories(released, 30_000, 5000)).toEqual([]);
    expect(dueRepositories(released, 30_000, 35_000)).toEqual(["acme/widget"]);
  });

  it("leaves other repositories' lock state untouched", () => {
    const snapshot = snapshotOf([
      { repository: "acme/widget" },
      { repository: "acme/gizmo" },
    ]);

    const locked = startTicking(snapshot, "acme/widget");

    expect(dueRepositories(locked, 0, 0)).toEqual(["acme/gizmo"]);
  });
});
