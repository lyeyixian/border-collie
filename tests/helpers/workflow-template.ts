import { readFileSync } from "node:fs";

/**
 * Readers for the scaffolded workflow templates (.github/workflows/), used by
 * the guards that hold those files to the contracts the rest of the system
 * assumes of them: the CLI pin (issue #93) and the Worker's `run-name` (issue
 * #111).
 *
 * These live in tests, and keep their own copies of the patterns, on purpose.
 * Runtime does rewrite a pin — `pinCliVersion` (src/core/scaffold.ts) re-pins
 * each template to the scaffolding CLI's own version — and
 * scripts/sync-workflow-version.mjs rewrites the same string again, staying a
 * plain node script with no build step. A guard that imported the pattern it
 * checks would wave through the very edit that broke it, so the templates are
 * read here as an outside reader sees them: what a Tick's shell will run.
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
const CLI_PIN_PATTERN = /(npm install -g border-collie@)(\S+)/;

/** The same pattern for rewriting rather than reading. Kept separate because
 * a `g` regex carries `lastIndex` between calls, and the reader below must
 * answer the same question every time it is asked. */
const CLI_PIN_PATTERN_ALL = new RegExp(CLI_PIN_PATTERN.source, "g");

/**
 * The version a scaffolded workflow pins the CLI to, or null if it names
 * none — a template that floats is as much a failure of the invariant as one
 * naming the wrong version, so an unpinned install reads as null rather than
 * as some default.
 */
export function pinnedCliVersion(template: string): string | null {
  return CLI_PIN_PATTERN.exec(template)?.[2] ?? null;
}

/**
 * A checked-in template as a scaffold writes it into a target repo: the same
 * bytes, with the CLI pin rewritten to `version` the way `pinCliVersion`
 * (src/core/scaffold.ts) rewrites it on the way out.
 *
 * That rewrite is why comparing scaffolded output against the raw checked-in
 * file compares the wrong thing. Byte-equality quietly asserts the checked-in
 * pin equals the scaffolding version — the one thing a release deliberately
 * breaks, since `npm version` moves package.json before the tag push
 * publishes anything and `sync:version` moves the pin only afterwards. The
 * tagged run is the whole window between them, so a byte-equal assertion
 * fails there and nowhere else (issue #123): both call sites normalised the
 * pin by hand, only one was updated when the rewrite landed (issue #99), and
 * every release after it was built to fail its first tagged run. They share
 * this now so the next change to the rewrite cannot update one and miss the
 * other.
 *
 * What the pin actually owes is one-sided and lives in `pinIsAhead`; here it
 * is normalised away, so what a caller compares is the rest of the template.
 */
export function templateAsScaffolded(relPath: string, version: string): string {
  return readFileSync(relPath, "utf8").replace(
    CLI_PIN_PATTERN_ALL,
    `$1${version}`,
  );
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
