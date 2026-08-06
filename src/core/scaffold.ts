/**
 * `init` (issue #76): scaffold the workflows a target repository needs into
 * it, and tell the operator what to supply so a missing credential is
 * discovered from a checklist before the first run rather than during it.
 * Pure planning, rendering, and the one rewrite the templates need on their
 * way out — reading them off disk, and this package's own version, are
 * adapters/scaffold.ts's concern.
 */

import {
  OPERATOR_STEERED_LABEL,
  ORCHESTRATOR_LABELS,
  type OrchestratorLabel,
  READY_FOR_AGENT,
} from "./types.js";

/**
 * The files `init` scaffolds, relative to the target repo root — the exact
 * workflows this repo runs on itself (see .github/workflows/), so a target
 * repo gets the Orchestrator (Tick, which also runs Conflict and Refinement
 * Workers inline — CONTEXT.md "Conflict Worker", "Refinement round") and the
 * Worker job, skills setup included.
 */
export const SCAFFOLD_FILES: readonly string[] = [
  ".github/workflows/border-collie-tick.yml",
  ".github/workflows/border-collie-worker.yml",
];

/**
 * How the scaffolded workflows install the CLI (issue #93). Global rather
 * than single-match: both the pin the templates carry for this repository's
 * own fleet and any later step naming the same install must move together,
 * because a workflow that installed two versions of one CLI would run
 * whichever step happened to be last.
 */
const CLI_PIN_PATTERN = /(npm install -g border-collie@)(\S+)/g;

/**
 * Point a template's CLI install at `version` (issue #99).
 *
 * The pin is a property of the CLI doing the scaffolding, not a constant in
 * the template: the templates are also this repository's own workflows, and
 * the tarball is built from the `v<N>` tag, which predates the commit that
 * moves those workflows to N. Baking the pin into the shipped text therefore
 * made version N scaffold N-1 forever. Resolved here instead, the version
 * written is the version scaffolding — which was installed from npm, so it is
 * by definition published, preserving the invariant the pin exists to protect
 * (a version not yet on npm 404s every unattended Tick).
 *
 * Still pinned, never `@latest`: an unattended fleet must not be handed a
 * breaking release overnight. `border-collie init --force` is how a repo
 * moves, and now it actually reaches the version that ran it.
 *
 * A template naming no install is a broken template rather than a template to
 * leave alone: it would hand the target repo a fleet that installs nothing.
 */
export function pinCliVersion(template: string, version: string): string {
  let pins = 0;
  const pinned = template.replace(CLI_PIN_PATTERN, (_match, install) => {
    pins += 1;
    return `${install}${version}`;
  });

  if (pins === 0) {
    throw new Error(
      "scaffold template has no `npm install -g border-collie@<version>` step to pin",
    );
  }

  return pinned;
}

export type ScaffoldOutcome = "written" | "overwritten" | "skipped-exists";

export interface ScaffoldAction {
  relPath: string;
  outcome: ScaffoldOutcome;
}

/**
 * Never overwrite an existing file silently: an existing path is left alone
 * unless `force` says otherwise, and either way the outcome names what
 * happened so the report can say so.
 */
export function planScaffold(
  existing: ReadonlySet<string>,
  force: boolean,
): ScaffoldAction[] {
  return SCAFFOLD_FILES.map((relPath) => {
    if (!existing.has(relPath)) return { relPath, outcome: "written" };
    return { relPath, outcome: force ? "overwritten" : "skipped-exists" };
  });
}

/** Which planned actions actually need a write — `skipped-exists` needs none. */
export function scaffoldWrites(actions: ScaffoldAction[]): ScaffoldAction[] {
  return actions.filter((action) => action.outcome !== "skipped-exists");
}

function actionLine(action: ScaffoldAction): string {
  switch (action.outcome) {
    case "written":
      return `  wrote      ${action.relPath}`;
    case "overwritten":
      return `  overwrote  ${action.relPath}`;
    case "skipped-exists":
      return `  skipped    ${action.relPath} (already exists — rerun with --force to overwrite)`;
  }
}

export function renderScaffoldReport(actions: ScaffoldAction[]): string {
  return ["Scaffolded workflows:", ...actions.map(actionLine)].join("\n");
}

export type LabelOutcome = "created" | "exists" | "failed";

export interface LabelAction {
  name: string;
  outcome: LabelOutcome;
  /** Why the tracker refused, on `failed` only. */
  error?: string;
}

/**
 * The command an operator runs to add a label `init` could not (issue #100),
 * so a tracker it cannot reach — no `gh` on the PATH, no remote yet, an
 * unauthenticated shell — degrades to the checklist treatment the App
 * permissions already get rather than to a silent gap.
 */
export function labelCreateCommand(label: OrchestratorLabel): string {
  return `gh label create ${label.name} --color ${label.color} --description ${JSON.stringify(label.description)}`;
}

function labelLine(action: LabelAction): string {
  switch (action.outcome) {
    case "created":
      return `  created    ${action.name}`;
    case "exists":
      return `  exists     ${action.name} (left as-is)`;
    case "failed":
      return `  failed     ${action.name}`;
  }
}

/**
 * The distinct refusals behind the failed actions, one indented line each and
 * in first-seen order. A subprocess failure arrives as a message with the
 * command's own stderr and its blank lines glued on, which would otherwise
 * open a hole in the middle of the report.
 */
function failureLines(actions: LabelAction[]): string[] {
  const reasons = actions
    .filter((action) => action.outcome === "failed")
    .map((action) => action.error?.trim() || "the tracker write failed");
  return [...new Set(reasons)].flatMap((reason) =>
    reason
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => `  ${line}`),
  );
}

/**
 * The label report (issue #100). Every label the loop depends on is listed,
 * created or not, because "exists" is the answer an operator re-running `init`
 * needs as much as "created". A label that could not be written is followed by
 * the reason and the hand-run command, since the first Claim of the first Tick
 * is otherwise where the gap surfaces.
 */
export function renderLabelReport(actions: LabelAction[]): string {
  const lines = ["Tracker labels:", ...actions.map(labelLine)];
  const failed = actions.filter((action) => action.outcome === "failed");
  if (failed.length > 0) {
    const byName = new Map(ORCHESTRATOR_LABELS.map((l) => [l.name, l]));
    lines.push(
      "",
      ...failureLines(actions),
      "",
      "  The Orchestrator writes these labels — the first Claim fails without",
      "  them. Create the failed ones by hand before the first Tick:",
      ...failed
        .map((action) => byName.get(action.name))
        .filter((label) => label !== undefined)
        .map((label) => `    ${labelCreateCommand(label)}`),
    );
  }
  return lines.join("\n");
}

/** The label set as prose, read off the one table so it cannot drift. */
function labelNames(): string {
  return ORCHESTRATOR_LABELS.map((label) => label.name).join(", ");
}

/**
 * The secrets and GitHub App permissions checklist (issue #76): a missing
 * credential is meant to be discovered here, before the first Tick, not from
 * a failed run. Mirrors what .github/workflows/border-collie-tick.yml and
 * border-collie-worker.yml actually read (README.md "Continuous operation").
 * `BORDER_COLLIE_APP_ID` is a repository *variable*, not a secret — it isn't
 * sensitive — matching both scaffolded workflows.
 *
 * The labels earn their place here for the same reason (issue #100): a
 * scaffolded repo that has every credential still fails its first Claim
 * without them, and a checklist that stayed silent about it sent the operator
 * to a failed run to find out.
 */
export function renderChecklist(): string {
  return `Next steps:

1. Create a GitHub App (https://github.com/settings/apps/new) and install it
   on this repository. Grant only these repository permissions:
     - Contents: Read and write
     - Issues: Read and write
     - Pull requests: Read and write
     - Actions: Read and write (triggers and reads Worker job runs; distinct
       from the Workflows permission below)
   Leave Workflows ungranted — an App that can rewrite workflow *files* would
   let a Worker rewrite the workflow that runs it.

2. In this repository's Settings > Secrets and variables > Actions, set:
     - Variable BORDER_COLLIE_APP_ID           the App's ID
     - Secret   BORDER_COLLIE_APP_PRIVATE_KEY  the App's private key (PEM)
     - Secret   CLAUDE_CODE_OAUTH_TOKEN         a subscription OAuth token
                                                (\`claude setup-token\`)

3. Add a border-collie.json at the repo root with at least a "parent" issue
   number (run \`border-collie --help\` for the full config shape).

4. Label a Ticket ${READY_FOR_AGENT} so the fleet has something to take.
   Applying it vouches for that Ticket's text as trusted input to an agent
   holding your credentials.

The tracker labels the loop depends on —
  ${labelNames()}
— are created by \`init\` itself, and the label report above says which ones
it had to add. Any it could not reach the tracker to create are named there
too, with the command to add them by hand; the first Claim of the first Tick
fails without them. Only ${OPERATOR_STEERED_LABEL} is ever applied by a human:
it is the flag that takes a pull request out of the automatic Refinement loop.

Worker skills install automatically inside each Worker job — no separate
setup step is needed for those.

The scaffolded workflows install border-collie from npm at a pinned version,
so this repository needs no build of its own to run one and keeps that
version until you re-scaffold with \`border-collie init --force\`.`;
}
