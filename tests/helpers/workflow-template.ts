/**
 * Readers for the scaffolded workflow templates (.github/workflows/), used by
 * the guards that hold those files to the contracts the rest of the system
 * assumes of them: the CLI pin (issue #93) and the Worker's `run-name` (issue
 * #111).
 *
 * These live in tests rather than in src because nothing at runtime reads a
 * template's *contents* — `init` copies the files through byte for byte
 * (adapters/scaffold.ts), and the one tool that does rewrite a pin,
 * scripts/sync-workflow-version.mjs, deliberately keeps its own copy of the
 * pattern so it can stay a plain node script with no build step. Parsing a
 * template is therefore something only an assertion ever wants, and core kept
 * only the planning `init` actually calls.
 */

/**
 * How the scaffolded workflows install the border-collie CLI — the Tick's
 * Orchestrator and the Worker entrypoint alike ship in the one package. A
 * target repo is not this repo: it has no `dist/` to run and no lockfile of
 * ours to install from, so the workflows install the published CLI rather
 * than building the checkout — the checkout is the repo being herded, never
 * the herder. The pin is deliberate: the Tick's half-hourly cron runs
 * unattended, and a floating `@latest` would hand an unattended fleet a
 * breaking release.
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

const RUN_NAME_PATTERN = /^run-name:[ \t]*(.*?)[ \t]*$/m;

/**
 * A workflow's top-level `run-name:` as *YAML* reads it, or null if it
 * declares none. The Worker template's is load-bearing rather than cosmetic
 * (issue #111): Worker liveness is read back off a run's display title, so a
 * template that declares none leaves every in-flight claim looking orphaned
 * to the next Tick.
 *
 * The unquoted case is the whole reason this reads YAML's semantics rather
 * than the line as written: a plain scalar ends at the first ` #`, so an
 * unquoted `run-name: border-collie worker #${{ inputs.ticket }} ...`
 * silently becomes `border-collie worker` — a broken template that a reader
 * echoing the raw line back would wave through.
 */
export function declaredRunName(template: string): string | null {
  const raw = RUN_NAME_PATTERN.exec(template)?.[1];
  if (raw === undefined || raw === "") return null;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);

  const comment = raw.search(/\s#/);
  const plain = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
  return plain === "" ? null : plain;
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
