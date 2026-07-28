import type { LogEvent } from "../core/log.js";
import {
  renderCompleteReport,
  renderPlanReport,
  renderStuckReport,
} from "../core/render.js";

/**
 * The console formatter's dispatch on a report event's kind: the familiar
 * unadorned text block, with no level or timestamp prefix bolted onto a
 * table. Null for every other kind, which the leveled console logger renders
 * instead. Kept free of the logging library so the dispatch itself is
 * testable without it.
 */
export function reportBlockText(event: LogEvent): string | null {
  switch (event.kind) {
    case "plan-report":
      return renderPlanReport(event.report);
    case "stuck-report":
      return renderStuckReport(event.report);
    case "complete-report":
      return renderCompleteReport(event.report);
    default:
      return null;
  }
}
