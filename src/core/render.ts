import { modelForAttempt, type ResolvedConfig } from "./config.js";
import type { WorkerHeartbeat } from "./heartbeat.js";
import { dispatchableSet } from "./plan.js";
import {
  type Action,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  type Ticket,
  type WorldSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Dispatch plan report
// ---------------------------------------------------------------------------

/** Why dispatch is paused this Tick, or absent when it isn't. */
export type PlanPausedReason =
  | { kind: "breaker" }
  | { kind: "working-hours" }
  | { kind: "max-open-prs"; openCount: number };

/** One planned action, resolved to exactly the fields its console line needs. */
export type PlanActionLine =
  | { type: "claim"; ticket: number; title: string }
  | { type: "release"; ticket: number; title: string }
  | {
      type: "spawn";
      ticket: number;
      title: string;
      model: string;
      attempt: number;
    }
  | { type: "escalate"; ticket: number; title: string }
  | { type: "close"; ticket: number; title: string; prUrl: string }
  | { type: "update-branch"; pr: number; title: string }
  | { type: "conflict-worker"; pr: number; title: string }
  | { type: "mark-ready"; pr: number; title: string };

export interface PlanReport {
  scopeLabel: string;
  totalTickets: number;
  openTickets: number;
  /** Dispatchable ticket numbers, in the order they'd claim. */
  dispatchable: number[];
  paused: PlanPausedReason | null;
  maxWorkers: number;
  maxOpenPrs: number;
  actions: PlanActionLine[];
  dryRun: boolean;
}

function toPlanActionLine(
  action: Action,
  title: string,
  config: ResolvedConfig,
): PlanActionLine {
  switch (action.type) {
    case "claim":
      return { type: "claim", ticket: action.ticket, title };
    case "release":
      return { type: "release", ticket: action.ticket, title };
    case "spawn":
      return {
        type: "spawn",
        ticket: action.ticket,
        title,
        model: modelForAttempt(config, action.attempt),
        attempt: action.attempt,
      };
    case "escalate":
      return { type: "escalate", ticket: action.ticket, title };
    case "close":
      return {
        type: "close",
        ticket: action.ticket,
        title,
        prUrl: action.prUrl,
      };
    case "update-branch":
      return { type: "update-branch", pr: action.pr, title };
    case "conflict-worker":
      return { type: "conflict-worker", pr: action.pr, title };
    case "mark-ready":
      return { type: "mark-ready", pr: action.pr, title };
  }
}

/** Build the dispatch plan report's data. Pure. */
export function buildPlanReport(
  config: ResolvedConfig,
  world: WorldSnapshot,
  actions: Action[],
  {
    dryRun,
    dispatchPaused = false,
    withinWorkingHours = false,
  }: {
    dryRun: boolean;
    dispatchPaused?: boolean;
    withinWorkingHours?: boolean;
  },
): PlanReport {
  const { scope, maxWorkers, maxOpenPrs } = config;
  const scopeLabel =
    scope.kind === "parent"
      ? `sub-issues of #${scope.parent}`
      : "repo-wide (--all)";
  const dispatchable = dispatchableSet(world).map((ticket) => ticket.number);

  let paused: PlanPausedReason | null = null;
  if (dispatchPaused) {
    paused = { kind: "breaker" };
  } else if (withinWorkingHours && dispatchable.length > 0) {
    paused = { kind: "working-hours" };
  } else if (
    dispatchable.length > 0 &&
    world.openAgentPrs.length >= maxOpenPrs
  ) {
    paused = { kind: "max-open-prs", openCount: world.openAgentPrs.length };
  }

  const titles = new Map(world.tickets.map((t) => [t.number, t.title]));
  const actionLines = actions.map((action) =>
    toPlanActionLine(action, titles.get(action.ticket) ?? "", config),
  );

  return {
    scopeLabel,
    totalTickets: world.tickets.length,
    openTickets: world.tickets.filter((t) => t.state === "open").length,
    dispatchable,
    paused,
    maxWorkers,
    maxOpenPrs,
    actions: actionLines,
    dryRun,
  };
}

function renderPlanActionLine(line: PlanActionLine): string {
  switch (line.type) {
    case "claim":
      return `  claim #${line.ticket} — ${line.title}`;
    case "release":
      return `  release #${line.ticket} — ${line.title} (orphaned agent claim)`;
    case "spawn":
      return `  spawn Worker for #${line.ticket} — ${line.title} (model ${line.model}, attempt ${line.attempt})`;
    case "escalate":
      return `  escalate #${line.ticket} — ${line.title} (attempts exhausted → ready-for-human)`;
    case "close":
      return `  close #${line.ticket} — ${line.title} (merged: ${line.prUrl})`;
    case "update-branch":
      return `  update PR #${line.pr} — ${line.title} (behind base, mechanical rebase)`;
    case "conflict-worker":
      return `  conflict Worker for PR #${line.pr} — ${line.title} (resolve merge conflicts)`;
    case "mark-ready":
      return `  mark PR #${line.pr} ready — ${line.title} (CI green)`;
  }
}

/** Render the dispatch plan report as the familiar unadorned text block. Pure. */
export function renderPlanReport(report: PlanReport): string {
  const lines: string[] = [];
  lines.push(
    `Scope: ${report.scopeLabel} — ${report.totalTickets} tickets (${report.openTickets} open)`,
  );

  lines.push(
    report.dispatchable.length === 0
      ? "Dispatchable: none"
      : `Dispatchable: ${report.dispatchable.map((n) => `#${n}`).join(", ")}`,
  );

  if (report.paused?.kind === "breaker") {
    lines.push(
      "Dispatch paused: circuit breaker open (infrastructure failure), claims held",
    );
  } else if (report.paused?.kind === "working-hours") {
    lines.push(
      "Dispatch paused: within working hours — claims, spawns, and Conflict Workers wait for the off-hours window",
    );
  } else if (report.paused?.kind === "max-open-prs") {
    lines.push(
      `Dispatch paused: ${report.paused.openCount} open agent PRs at max_open_prs (${report.maxOpenPrs})`,
    );
  }

  if (report.actions.length === 0) {
    lines.push(
      `Plan (max_workers=${report.maxWorkers}, max_open_prs=${report.maxOpenPrs}): nothing to do`,
    );
  } else {
    lines.push(
      `Plan (max_workers=${report.maxWorkers}, max_open_prs=${report.maxOpenPrs}):`,
    );
    lines.push(...report.actions.map(renderPlanActionLine));
  }

  if (report.dryRun) lines.push("Dry run: no writes performed.");
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * Render the fleet heartbeat: one line covering every in-flight Worker, each
 * with its elapsed time and time since its last output — the two signals
 * that distinguish slow from stuck. Pure.
 */
export function renderHeartbeat(workers: WorkerHeartbeat[]): string {
  const entries = workers
    .map(
      (w) =>
        `#${w.ticket} attempt ${w.attempt} (elapsed ${formatDuration(w.elapsedMs)}, since output ${formatDuration(w.sinceOutputMs)})`,
    )
    .join(", ");
  return `Heartbeat: ${workers.length} Worker${workers.length === 1 ? "" : "s"} in flight — ${entries}`;
}

// ---------------------------------------------------------------------------
// Stuck report
// ---------------------------------------------------------------------------

/**
 * Why one open ticket cannot move without a human, as structured data — "what
 * blocked what" is answerable without parsing a rendered block.
 */
export type StuckReasonDetail =
  | { kind: "human-claim"; assignees: string[] }
  | { kind: "ready-for-human" }
  | { kind: "not-ready-for-agent" }
  | { kind: "blocked-by"; blockers: { ticket: number; inScope: boolean }[] }
  | { kind: "blocked-count"; count: number };

export interface StuckTicketReport {
  ticket: number;
  title: string;
  reasons: StuckReasonDetail[];
}

export interface StuckReport {
  tickets: StuckTicketReport[];
}

/**
 * Any assignee at a Stuck exit is a human claim: agent claims are either
 * orphans (released before the exit) or backed by a PR (which keeps the run
 * polling).
 */
function stuckReasons(
  ticket: Ticket,
  inScope: Set<number>,
): StuckReasonDetail[] {
  const reasons: StuckReasonDetail[] = [];
  if (ticket.assignees.length > 0) {
    reasons.push({ kind: "human-claim", assignees: ticket.assignees });
  }
  if (ticket.labels.includes(READY_FOR_HUMAN)) {
    reasons.push({ kind: "ready-for-human" });
  } else if (!ticket.labels.includes(READY_FOR_AGENT)) {
    reasons.push({ kind: "not-ready-for-agent" });
  }
  if (ticket.openBlockers > 0) {
    // Blockers outside Scope are flagged: their tickets get no line of their
    // own in this report. The count is the fallback for an unread list.
    reasons.push(
      ticket.blockedBy.length > 0
        ? {
            kind: "blocked-by",
            blockers: ticket.blockedBy.map((n) => ({
              ticket: n,
              inScope: inScope.has(n),
            })),
          }
        : { kind: "blocked-count", count: ticket.openBlockers },
    );
  }
  return reasons;
}

/** Build the Stuck exit report's data: each remaining open ticket and exactly what it is stuck on. Pure. */
export function buildStuckReport(world: WorldSnapshot): StuckReport {
  const inScope = new Set(world.tickets.map((t) => t.number));
  return {
    tickets: world.tickets
      .filter((ticket) => ticket.state === "open")
      .map((ticket) => ({
        ticket: ticket.number,
        title: ticket.title,
        reasons: stuckReasons(ticket, inScope),
      })),
  };
}

function renderStuckReasonText(reason: StuckReasonDetail): string {
  switch (reason.kind) {
    case "human-claim":
      return `claimed by ${reason.assignees.join(", ")} — a human claim, hands off`;
    case "ready-for-human":
      return `labelled ${READY_FOR_HUMAN}`;
    case "not-ready-for-agent":
      return `not labelled ${READY_FOR_AGENT}`;
    case "blocked-by":
      return `blocked by ${reason.blockers
        .map((b) =>
          b.inScope ? `#${b.ticket}` : `#${b.ticket} (outside Scope)`,
        )
        .join(", ")}`;
    case "blocked-count":
      return `${reason.count} open blocker${reason.count === 1 ? "" : "s"}`;
  }
}

/** Render the Stuck exit report as the familiar unadorned text block. Pure. */
export function renderStuckReport(report: StuckReport): string {
  return [
    "Run Stuck: open tickets remain, but every path forward runs through a human.",
    ...report.tickets.map((ticket) => {
      const reasonText =
        ticket.reasons.map(renderStuckReasonText).join("; ") ||
        "no path forward found";
      return `  #${ticket.ticket} — ${ticket.title} (${reasonText})`;
    }),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Complete report
// ---------------------------------------------------------------------------

export interface CompleteTicketReport {
  ticket: number;
  title: string;
  /** Closed after going through Escalation and being finished by a human. */
  escalated: boolean;
}

export interface CompleteReport {
  tickets: CompleteTicketReport[];
}

/** Build the Complete exit report's data: every ticket in Scope, closed. Pure. */
export function buildCompleteReport(tickets: Ticket[]): CompleteReport {
  return {
    tickets: tickets.map((ticket) => ({
      ticket: ticket.number,
      title: ticket.title,
      escalated: ticket.labels.includes(READY_FOR_HUMAN),
    })),
  };
}

/** Render the Complete exit report as the familiar unadorned text block. Pure. */
export function renderCompleteReport(report: CompleteReport): string {
  const count = `${report.tickets.length} ticket${report.tickets.length === 1 ? "" : "s"}`;
  return [
    `Run Complete: every ticket in Scope is closed (${count}).`,
    ...report.tickets.map((ticket) => {
      const escalated = ticket.escalated
        ? " (closed by a human after Escalation)"
        : "";
      return `  #${ticket.ticket} — ${ticket.title}${escalated}`;
    }),
  ].join("\n");
}
