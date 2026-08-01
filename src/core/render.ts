import { modelForAttempt, type ResolvedConfig } from "./config.js";
import type { WorkerHeartbeat } from "./heartbeat.js";
import { dispatchableSet } from "./plan.js";
import {
  type Action,
  READY_FOR_AGENT,
  READY_FOR_HUMAN,
  type Ticket,
  type WorkerOutcome,
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

// ---------------------------------------------------------------------------
// Forensic comment (failed Attempt evidence)
// ---------------------------------------------------------------------------

/** One tool name's whole-session call count, most-called first. */
export interface ToolTally {
  name: string;
  count: number;
}

/** One assistant turn near the end of the session, rendered readable. */
export interface ForensicTurn {
  /** 1-based position among every assistant turn in the whole session. */
  index: number;
  text: string | undefined;
  /** Rendered as `name(input summary)`, e.g. `Bash({"command":"npm test"})`. */
  toolCalls: string[];
}

/** The result facts a survived transcript's result event carries, echoed from the outcome so the comment needs no re-parse. */
export interface ForensicFacts {
  turns: number | undefined;
  costUsd: number | undefined;
  durationMs: number | undefined;
  subtype: string | undefined;
}

export interface ForensicReport {
  facts: ForensicFacts;
  /** Every tool call in the whole session, not just the tail — a Worker that burned its turn cap did so by looping, and only a whole-session view shows that. */
  histogram: ToolTally[];
  /** The session's last few assistant turns, readable rather than raw stream-json. */
  finalTurns: ForensicTurn[];
}

/** How many of the session's final assistant turns are rendered in full. */
export const FORENSIC_FINAL_TURNS = 8;

/** How much of one turn's text survives before truncation. */
const FORENSIC_TEXT_LIMIT = 600;

/** How much of one tool call's input summary survives before truncation. */
const FORENSIC_INPUT_LIMIT = 200;

/**
 * The forensic section's hard ceiling — comfortably under GitHub's
 * 65536-character comment limit once the release marker and one-liner join
 * it. The per-turn limits above already keep a normal comment far under this;
 * it exists as a backstop against a pathological single turn, not the
 * mechanism that makes a long session's comment fit.
 */
export const MAX_FORENSIC_LENGTH = 50_000;

/** Truncates to at most `limit` characters total, ellipsis included. */
function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `text` content block's text, joined — empty for a tool-only turn. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Every `tool_use` content block, name plus raw input. */
function toolCallsOf(content: unknown): { name: string; input: unknown }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isRecord)
    .filter(
      (block) => block.type === "tool_use" && typeof block.name === "string",
    )
    .map((block) => ({ name: block.name as string, input: block.input }));
}

interface AssistantTurn {
  text: string;
  toolCalls: { name: string; input: unknown }[];
}

/**
 * Every assistant turn in a transcript, in order. Tolerant of stray non-JSON
 * lines and malformed events — the transcript is subprocess output, not a
 * trusted document (mirrors `parseResultEvent`'s and `workerFinalMessage`'s
 * tolerance).
 */
function assistantTurns(transcript: string): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "assistant") continue;
    const content = isRecord(event.message) ? event.message.content : undefined;
    turns.push({ text: textOf(content), toolCalls: toolCallsOf(content) });
  }
  return turns;
}

function buildToolHistogram(turns: AssistantTurn[]): ToolTally[] {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function summarizeInput(input: unknown): string {
  try {
    return truncateText(
      JSON.stringify(input) ?? "undefined",
      FORENSIC_INPUT_LIMIT,
    );
  } catch {
    return "(unrenderable input)";
  }
}

/**
 * Build the forensic comment's data: the result facts already captured on the
 * outcome, a whole-session tool-call histogram, and the final turns readable
 * rather than raw. Pure — `transcript` is whatever the caller read (the file
 * may be gone by the time a human reads the rendered comment, which is the
 * point of baking this in now); an empty or unparseable transcript still
 * yields the outcome's own facts, with an empty histogram and no final turns.
 */
export function buildForensicReport(
  outcome: WorkerOutcome,
  transcript: string,
): ForensicReport {
  const turns = assistantTurns(transcript);
  const sliceStart = Math.max(0, turns.length - FORENSIC_FINAL_TURNS);
  const finalTurns: ForensicTurn[] = turns.slice(sliceStart).map((turn, i) => {
    const text = turn.text.trim();
    return {
      index: sliceStart + i + 1,
      text: text === "" ? undefined : truncateText(text, FORENSIC_TEXT_LIMIT),
      toolCalls: turn.toolCalls.map(
        (call) => `${call.name}(${summarizeInput(call.input)})`,
      ),
    };
  });
  return {
    facts: {
      turns: outcome.turns,
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      subtype: outcome.subtype,
    },
    histogram: buildToolHistogram(turns),
    finalTurns,
  };
}

function renderFacts(facts: ForensicFacts): string {
  const turns = facts.turns !== undefined ? String(facts.turns) : "unknown";
  const cost =
    facts.costUsd !== undefined ? `$${facts.costUsd.toFixed(2)}` : "unknown";
  const duration =
    facts.durationMs !== undefined
      ? formatDuration(facts.durationMs)
      : "unknown";
  const subtype = facts.subtype ?? "unknown";
  return `${turns} turns, ${cost}, ${duration}, terminated \`${subtype}\``;
}

function renderHistogram(histogram: ToolTally[]): string {
  if (histogram.length === 0) return "(no tool calls recorded)";
  return histogram.map((tally) => `- ${tally.name}: ${tally.count}`).join("\n");
}

function renderTurn(turn: ForensicTurn): string {
  const lines = [`Turn ${turn.index}:`];
  if (turn.text !== undefined) lines.push(turn.text);
  lines.push(...turn.toolCalls.map((call) => `→ ${call}`));
  return lines.join("\n");
}

/**
 * Render the forensic comment's body: result facts, the whole-session tool
 * histogram, then the final turns — everything a failed Attempt's evidence
 * needs, readable without downloading a transcript that a runner may have
 * already discarded. Bounded to `MAX_FORENSIC_LENGTH` as a backstop. Pure.
 */
export function renderForensicReport(report: ForensicReport): string {
  const body = [
    `**Result:** ${renderFacts(report.facts)}`,
    "",
    "**Tool calls (whole session):**",
    renderHistogram(report.histogram),
    "",
    report.finalTurns.length === 0
      ? "**Final turns:** (none recorded)"
      : `**Final turns:**\n\n${report.finalTurns.map(renderTurn).join("\n\n")}`,
  ].join("\n");
  return truncateText(body, MAX_FORENSIC_LENGTH);
}
