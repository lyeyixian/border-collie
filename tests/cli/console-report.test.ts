import { describe, expect, it } from "vitest";
import { reportBlockText } from "../../src/cli/console-report.js";
import type { LogEvent } from "../../src/core/log.js";
import type {
  CompleteReport,
  PlanReport,
  StuckReport,
} from "../../src/core/render.js";
import {
  renderCompleteReport,
  renderPlanReport,
  renderStuckReport,
} from "../../src/core/render.js";

const PLAN_REPORT: PlanReport = {
  scopeLabel: "sub-issues of #1",
  totalTickets: 1,
  openTickets: 1,
  dispatchable: [2],
  paused: null,
  maxWorkers: 3,
  maxOpenPrs: 5,
  actions: [{ type: "claim", ticket: 2, title: "Walking skeleton" }],
  dryRun: true,
};

const STUCK_REPORT: StuckReport = {
  tickets: [
    { ticket: 7, title: "Escalated", reasons: [{ kind: "ready-for-human" }] },
  ],
};

const COMPLETE_REPORT: CompleteReport = {
  tickets: [{ ticket: 2, title: "Walking skeleton", escalated: false }],
};

describe("reportBlockText", () => {
  it("renders a plan-report event as the plan's unadorned text block", () => {
    const event: LogEvent = {
      kind: "plan-report",
      level: "info",
      msg: "dispatch plan",
      report: PLAN_REPORT,
    };

    expect(reportBlockText(event)).toBe(renderPlanReport(PLAN_REPORT));
  });

  it("renders a stuck-report event as the Stuck report's unadorned text block", () => {
    const event: LogEvent = {
      kind: "stuck-report",
      level: "warn",
      msg: "run stuck",
      report: STUCK_REPORT,
    };

    expect(reportBlockText(event)).toBe(renderStuckReport(STUCK_REPORT));
  });

  it("renders a complete-report event as the Complete report's unadorned text block", () => {
    const event: LogEvent = {
      kind: "complete-report",
      level: "info",
      msg: "run complete",
      report: COMPLETE_REPORT,
    };

    expect(reportBlockText(event)).toBe(renderCompleteReport(COMPLETE_REPORT));
  });

  it("returns null for narration events, leaving them to the leveled console logger", () => {
    const event: LogEvent = {
      kind: "next-tick",
      level: "info",
      msg: "Next Tick in 30s.",
      pollSeconds: 30,
    };

    expect(reportBlockText(event)).toBeNull();
  });
});
