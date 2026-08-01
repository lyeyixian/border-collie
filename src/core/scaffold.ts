/**
 * `init` (issue #76): scaffold the workflows a target repository needs into
 * it, and tell the operator what to supply so a missing credential is
 * discovered from a checklist before the first run rather than during it.
 * Pure planning and rendering only — the filesystem and the template
 * content itself are adapters/scaffold.ts's concern.
 */

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
 * How the scaffolded workflows install the border-collie CLI (issue #93) — the
 * Tick's Orchestrator and the Worker entrypoint alike ship in the one package.
 * A target repo is not this repo: it has no `dist/` to run and no lockfile of
 * ours to install from, so the workflows install the published CLI rather than
 * building the checkout — the checkout is the repo being herded, never the
 * herder. The pin is deliberate: the Tick's half-hourly cron runs unattended,
 * and a floating `@latest` would hand an unattended fleet a breaking release.
 */
const CLI_PIN_PATTERN = /npm install -g border-collie@(\S+)/;

/**
 * The version a scaffolded workflow pins the CLI to, or null if it names
 * none — a template that floats is as much a failure of the invariant as one
 * naming the wrong version, so an unpinned install reads as null rather than
 * as some default.
 */
export function pinnedCliVersion(template: string): string | null {
  return CLI_PIN_PATTERN.exec(template)?.[1] ?? null;
}

function versionParts(version: string): number[] {
  const release = version.split("-")[0] ?? version;
  return release.split(".").map(Number);
}

/**
 * Whether a pin names a version newer than this package's own — the one
 * state that is always broken, because a version this package has not
 * reached cannot be on npm yet and `npm install -g border-collie@<it>` can
 * only 404.
 *
 * A pin *behind* package.json is fine, and is the normal state for a release
 * (issue #93): `npm version` bumps package.json before the tag push
 * publishes anything, so between those two moments this repo's own fleet has
 * to keep running the last version that actually exists. `pnpm run
 * sync:version` moves the pin up afterwards, once there is something to move
 * it to — so the pin lags a release rather than leading it.
 *
 * Prerelease identifiers are compared on the release triple alone, which is
 * all this guard needs: it exists to catch a pin naming an unpublished
 * *version*, not to order two prereleases of one.
 */
export function pinIsAhead(pin: string, packageVersion: string): boolean {
  const pinned = versionParts(pin);
  const own = versionParts(packageVersion);

  for (let i = 0; i < Math.max(pinned.length, own.length); i++) {
    const a = pinned[i] ?? 0;
    const b = own[i] ?? 0;
    if (a !== b) return a > b;
  }

  return false;
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

/**
 * The secrets and GitHub App permissions checklist (issue #76): a missing
 * credential is meant to be discovered here, before the first Tick, not from
 * a failed run. Mirrors what .github/workflows/border-collie-tick.yml and
 * border-collie-worker.yml actually read (README.md "Continuous operation").
 * `BORDER_COLLIE_APP_ID` is a repository *variable*, not a secret — it isn't
 * sensitive — matching both scaffolded workflows.
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

Worker skills install automatically inside each Worker job — no separate
setup step is needed for those.

The scaffolded workflows install border-collie from npm at a pinned version,
so this repository needs no build of its own to run one and keeps that
version until you re-scaffold with \`border-collie init --force\`.`;
}
