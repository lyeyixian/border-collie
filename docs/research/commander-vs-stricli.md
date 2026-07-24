# CLI library research: commander vs stricli

Research notes (not a decision — see final section). Candidates for replacing the
hand-rolled `node:util` `parseArgs` CLI in `src/cli.ts`: two subcommands (`tick`,
`run`) sharing one set of 9 flags, 4 of them integer-validated by `parseIntFlag`
(`src/cli.ts:72-81`). All claims below are from primary sources fetched
2026-07-25; every number links to the API/file that owns it.

## Summary table

| Dimension | commander 15.0.0 | @stricli/core 1.3.0 |
|---|---|---|
| Latest release | v15.0.0, 2026-05-29 ([GH releases](https://api.github.com/repos/tj/commander.js/releases)) | 1.3.0, 2026-07-16 ([registry `time`](https://registry.npmjs.org/@stricli/core)) |
| Runtime deps (transitive) | **0** ([registry](https://registry.npmjs.org/commander/latest)) | **0** ([registry](https://registry.npmjs.org/@stricli/core/latest)) |
| Unpacked size | 207,368 B / 12 files | 327,327 B / 6 files |
| Weekly downloads (2026-07-17..23) | 458,040,583 ([api](https://api.npmjs.org/downloads/point/last-week/commander)) | 696,680 ([api](https://api.npmjs.org/downloads/point/last-week/@stricli/core)) |
| GitHub stars | 28,329 ([api](https://api.github.com/repos/tj/commander.js)) | 1,068 ([api](https://api.github.com/repos/bloomberg/stricli)) |
| Open issues (excl. PRs) | 4 ([search](https://api.github.com/search/issues?q=repo:tj/commander.js+type:issue+state:open)) | 19 ([search](https://api.github.com/search/issues?q=repo:bloomberg/stricli+type:issue+state:open)) |
| Last push | 2026-07-24 | 2026-07-24 |
| Releases, past 12 months | 5 (4 stable + 1 pre) | 10 |
| Dominant committer | shadowspawn, 572 commits (next: 183) | molisani, 122 commits (next: 30); Bloomberg org owns npm scope |
| Flag value typing | `Record<string, any>` by default; strong only via extra package | Declared `Flags` type checked against spec, built in |
| Test invocation | `exitOverride()` + `configureOutput()` + `parse(args, {from:'user'})`; calls `process.exit()` by default | `run(app, args, context)`; never calls `process.exit` |
| ESM for `"type":"module"` consumer | Yes — ESM package, single `exports` entry | Yes — dual `import`/`require` exports |
| Node engines | `>=22.12.0` | none declared |
| Migration shape | rewrite inside `src/cli.ts`, similar LOC | spec/impl split, 2–3 files, most LOC changed |

## 1. API shape

### commander

Derived from the [README](https://github.com/tj/commander.js/blob/master/Readme.md):
subcommands via `.command()` with `.action()` handlers; custom option processing
via an argParser function that throws `InvalidArgumentError` (the README's
`myParseInt` example); multi-word options are camel-cased ("Multi-word options
like `--template-engine` are … properties such as `program.opts().templateEngine`").

```ts
import { Command, InvalidArgumentError } from "commander";

function parseIntFlag(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`must be an integer, got "${value}"`);
  }
  return Number(value);
}

function withSharedFlags(cmd: Command): Command {
  return cmd
    .option("--dry-run", "print the dispatch plan without writing anything (tick only)")
    .option("--parent <n>", "scope: sub-issues of parent issue #n", parseIntFlag)
    .option("--all", "scope: every agent-ready issue in the repo")
    .option("--max-workers <n>", "cap on planned claims", parseIntFlag)
    .option("--max-open-prs <n>", "open agent PRs that pause dispatch", parseIntFlag)
    .option("--poll-seconds <n>", "seconds between run's ticks", parseIntFlag)
    .option("--model <name>", "model Workers run on")
    .option("--retry-model <name>", "model second attempts run on");
}

const program = new Command("border-collie");
withSharedFlags(program.command("tick"))
  .description("run one idempotent pass")
  .action(async (opts) => { /* opts.maxWorkers etc. */ });
withSharedFlags(program.command("run"))
  .description("repeat ticks until Complete or Stuck")
  .action(async (opts) => { /* ... */ });
await program.parseAsync();
```

Help is auto-generated; the long USAGE prose would move into
`.description()`/`.addHelpText()` (positions `beforeAll`/`before`/`after`/`afterAll`,
[README "Custom help"](https://github.com/tj/commander.js/blob/master/Readme.md)).

### stricli

Derived from the docs' verbatim playground example
([parsed-flag example](https://github.com/bloomberg/stricli/blob/main/docs/docs/features/argument-parsing/examples/parsed-flag.txt))
and the [route-maps](https://bloomberg.github.io/stricli/docs/features/command-routing/route-maps) /
[commands](https://bloomberg.github.io/stricli/docs/features/command-routing/commands) pages.
`numberParser` accepts any number (`Number()` + throw on NaN,
[number.ts](https://github.com/bloomberg/stricli/blob/main/packages/core/src/parameter/parser/number.ts)),
so the integer-only rule keeps a custom parser:

```ts
import { buildApplication, buildCommand, buildRouteMap, run } from "@stricli/core";

function integerParser(input: string): number {
  if (!/^\d+$/.test(input)) throw new SyntaxError(`must be an integer, got "${input}"`);
  return Number(input);
}

type SharedFlags = {
  dryRun: boolean;
  parent?: number;
  all: boolean;
  maxWorkers?: number;
  maxOpenPrs?: number;
  pollSeconds?: number;
  model?: string;
  retryModel?: string;
};

const sharedFlags = {
  dryRun: { kind: "boolean", brief: "print the dispatch plan (tick only)", default: false },
  parent: { kind: "parsed", parse: integerParser, brief: "scope: sub-issues of parent #n", optional: true },
  all: { kind: "boolean", brief: "scope: every agent-ready issue", default: false },
  maxWorkers: { kind: "parsed", parse: integerParser, brief: "cap on planned claims", optional: true },
  maxOpenPrs: { kind: "parsed", parse: integerParser, brief: "open agent PRs that pause dispatch", optional: true },
  pollSeconds: { kind: "parsed", parse: integerParser, brief: "seconds between run's ticks", optional: true },
  model: { kind: "parsed", parse: String, brief: "model Workers run on", optional: true },
  retryModel: { kind: "parsed", parse: String, brief: "model second attempts run on", optional: true },
} as const;

const tickCommand = buildCommand({
  func: async function (flags: SharedFlags) { /* typed */ },
  parameters: { flags: sharedFlags },
  docs: { brief: "run one idempotent pass against the target repo" },
});
const runCommand = buildCommand({
  func: async function (flags: SharedFlags) { /* typed */ },
  parameters: { flags: sharedFlags },
  docs: { brief: "repeat ticks until Complete (exit 0) or Stuck (exit 1)" },
});

export const app = buildApplication(
  buildRouteMap({
    routes: { tick: tickCommand, run: runCommand },
    docs: { brief: "orchestration loop for a fleet of Claude Code agents" },
  }),
  { name: "border-collie" },
);

// bin script:
await run(app, process.argv.slice(2), { process });
```

Flag names are camelCase object keys; kebab-case input (`--max-workers`) requires
the scanner `caseStyle: "allow-kebab-for-camel"` configuration — default
(`original`) "requires that any input match the defined name exactly"
([configuration docs](https://bloomberg.github.io/stricli/docs/features/configuration)).

## 2. TypeScript typing quality

- commander: `export type OptionValues = Record<string, any>;` and
  `opts<T extends OptionValues>(): T;` — untyped by default, `T` is a caller
  assertion, and `action(fn: (this: this, ...args: any[]) => …)`
  ([typings/index.d.ts](https://github.com/tj/commander.js/blob/master/typings/index.d.ts)).
  Strong inference exists only via the optional
  [`@commander-js/extra-typings`](https://github.com/commander-js/extra-typings)
  package ("adds strong typing to the options returned by `.opts()` and the
  parameters to `.action()`" — [README](https://github.com/tj/commander.js/blob/master/Readme.md));
  v15.0.0, zero deps, `peerDependencies: { commander: "~15.0.0" }`
  ([registry](https://registry.npmjs.org/@commander-js/extra-typings/latest)).
- stricli: "Stricli infers the shape of parameter definitions from the
  TypeScript types used in the implementation" — the spec is conditionally typed
  from the declared `Flags` type ("When a property exists on the type used to
  define the flags, it must be represented in the specification"), and requires
  `strict: true` / `strictNullChecks`
  ([argument-parsing docs](https://bloomberg.github.io/stricli/docs/features/argument-parsing),
  [flags docs](https://bloomberg.github.io/stricli/docs/features/argument-parsing/flags)).
  border-collie is already strict TS, so this constraint is free.

## 3. Runtime dependency footprint

- commander 15.0.0: `dependencies` empty → **0 transitive**; 207,368 B unpacked,
  12 files ([registry](https://registry.npmjs.org/commander/latest)).
- @stricli/core 1.3.0: `dependencies` empty → **0 transitive**; 327,327 B
  unpacked, 6 files ([registry](https://registry.npmjs.org/@stricli/core/latest));
  README bills it as "type safety and no dependencies"
  ([README](https://github.com/bloomberg/stricli/blob/main/README.md)).
- Adding commander *with* strong typing means two packages
  (commander + extra-typings, both zero-dep). Either choice ends border-collie's
  current zero-runtime-dependency state (`package.json` has no `dependencies` field).

## 4. Testability

- commander: by default "Commander calls `process.exit()` when it detects
  errors, or after displaying the help or version". Tests opt out with
  `exitOverride()` (throws `CommanderError` instead), redirect output with
  `configureOutput({ writeOut, writeErr, outputError })`, and pass argv directly
  via `program.parse(['--port', '80'], { from: 'user' })`
  ([README, "Override exit and output handling"](https://github.com/tj/commander.js/blob/master/Readme.md)).
  Escape hatches around default process-owning behavior. (Open issue
  [#2549](https://github.com/tj/commander.js/issues/2549) asks for injectable env,
  i.e. env is still global today.)
- stricli: inverted — the entry point *always* injects context.
  `runApplication(app, rawInputs, context): Promise<number>` returns the exit
  code and never calls `process.exit`
  ([run.ts](https://github.com/bloomberg/stricli/blob/main/packages/core/src/application/run.ts));
  the `run` wrapper only does `context.process.exitCode ??= exitCode`
  ([index.ts](https://github.com/bloomberg/stricli/blob/main/packages/core/src/index.ts)).
  `CommandContext` is just `{ process: { stdout, stderr } }`
  ([context.ts](https://github.com/bloomberg/stricli/blob/main/packages/core/src/context.ts)).
  The [testing docs](https://bloomberg.github.io/stricli/docs/testing) show
  `await run(app, ["echo", "hello"], fakeContext)` with assertions on the fake's
  captured stdout/stderr — no globals touched. This matches how `src/cli.ts:188-194`
  already injects `tick`/`probe`/`now`/`sleep`/`log` into `run()`.

## 5. Maintenance health

| Metric | commander | stricli | Source |
|---|---|---|---|
| Latest version | 15.0.0 (2026-05-29) | 1.3.0 (2026-07-16) | [GH releases](https://api.github.com/repos/tj/commander.js/releases), [registry](https://registry.npmjs.org/@stricli/core) |
| Releases 2025-07-25..2026-07-25 | 5: v14.0.1 (2025-09-12), v14.0.2 (2025-10-25), v14.0.3 (2026-01-31), v15.0.0-0 (2026-02-21), v15.0.0 (2026-05-29) | 10: 1.2.1–1.2.4 (2025-10-13/14), 1.2.5 (2026-01-06), 1.2.6 (2026-02-20), 1.2.7 (2026-05-14), 1.2.8 (2026-06-18), 1.2.9 (2026-07-02), 1.3.0 (2026-07-16) | same |
| Weekly downloads | 458,040,583 | 696,680 | [npm api](https://api.npmjs.org/downloads/point/last-week/commander), [npm api](https://api.npmjs.org/downloads/point/last-week/@stricli/core) |
| Stars / forks / watchers | 28,329 / 1,762 / 224 | 1,068 / 25 / 11 | [GH api](https://api.github.com/repos/tj/commander.js), [GH api](https://api.github.com/repos/bloomberg/stricli) |
| Open issues (excl. PRs) | 4 | 19 | GH search api (above) |
| Last push | 2026-07-24 | 2026-07-24 | GH api |
| Top contributors | shadowspawn 572, tj 183, zhiyelee 149, abetomo 130 | molisani 122, jeffposnick 30, tchetwin 4 | [GH api](https://api.github.com/repos/tj/commander.js/contributors), [GH api](https://api.github.com/repos/bloomberg/stricli/contributors) |
| npm publish rights | (individual project, since 2011) | bloomberg-oss, bbgbuilder, molisani ([registry](https://registry.npmjs.org/@stricli/core)) | |

Bus factor: both have one dominant committer (shadowspawn 3x the next;
molisani 4x the next). stricli's counterweight is Bloomberg org ownership of the
npm scope; commander's is 15 years of history and a huge dependent base.
stricli's 19 open issues on a young repo are mostly feature requests
(global flags, autocomplete shells, env-var defaults — GH search above).

## 6. Migration effort from current parseArgs code

Current shape (`src/cli.ts`, 207 lines): USAGE string lines 24–70,
`parseIntFlag` 72–81, `parseArgs` options block 129–143, help/command validation
145–153, manual `Flags` mapping 154–166, tick/run routing 171–195, exit-code
plumbing 198–206.

- **commander** (~60–80 lines touched, one file): `parseArgs` block + manual
  mapping + `parseIntFlag` collapse into the option definitions above (validator
  survives nearly verbatim as an argParser throwing `InvalidArgumentError`
  instead of `ConfigError`). tick/run `if` routing becomes two `.action()`
  handlers around unchanged `tickOnce`/`run`. The 47-line USAGE prose splits into
  auto-generated options help + `.addHelpText()` blocks. Main structural change:
  commander owns parse/help/exit by default (`process.exit()` on error), so the
  current "main returns a code, one place sets `process.exitCode`" pattern
  (lines 198–206) either yields to commander's behavior or is preserved via
  `exitOverride()`.
- **stricli** (~120–150 lines new/moved, 2–3 files): bigger restructure —
  command specs (`buildCommand` ×2, `buildRouteMap`, `buildApplication`) become
  export-only modules, with a thin bin script calling `run(app, argv, { process })`
  (the docs template does exactly this "so that the rest of the source only
  contains exports without side-effects" —
  [quick start](https://bloomberg.github.io/stricli/docs/quick-start)).
  `parseIntFlag` survives verbatim as a `parse` function. The manual `Flags`
  mapping disappears entirely — the typed flags object *is* `Flags`. USAGE prose
  maps to `docs.fullDescription` per command. Needs
  `caseStyle: "allow-kebab-for-camel"` to keep `--max-workers` spelling, and
  run's Complete/Stuck exit codes map naturally since `runApplication` returns
  `Promise<number>` / `run` sets `context.process.exitCode` — same contract as
  the current `main()`.

Neither migration touches `tickOnce`, `run`, `resolveConfig`, or any module
other than `src/cli.ts` (plus, for stricli, a new bin/spec split).

## 7. ESM support

- commander 15.0.0: `"type": "module"`, `exports: { ".": { types: "./typings/index.d.ts", default: "./index.js" } }`,
  `engines: { node: ">=22.12.0" }` ([registry](https://registry.npmjs.org/commander/latest)).
  Native ESM import for a `"type": "module"` consumer; README shows both `import`
  and `require` usage (the engines floor is the first line where `require(esm)` works).
- @stricli/core 1.3.0: `"type": "module"`, dual
  `exports: { import: "./dist/index.js", require: "./dist/index.cjs" }`,
  `types: "dist/index.d.ts"`, no engines constraint
  ([registry](https://registry.npmjs.org/@stricli/core/latest),
  [package.json](https://github.com/bloomberg/stricli/blob/main/packages/core/package.json)).

Both are fully compatible with border-collie's `"type": "module"` / Node >=24.

## Agent-familiarity consideration

Argument raised by the requesting engineer (not from the sources above):
border-collie is routinely edited by autonomous Claude Code agents, so how well
a library's API is represented in model training data is itself a maintenance
factor. commander (2011, ~458M downloads/week) is among the most heavily
represented npm APIs in any training corpus; stricli (first published
2024-09-30, ~697k/week) is comparatively niche, and its conditional-type flag
specs are the kind of API agents are likelier to get subtly wrong without
consulting docs (mitigated somewhat by stricli publishing llms.txt docs —
[README](https://github.com/bloomberg/stricli/blob/main/README.md)). Note the
same argument cuts against *any* migration: `node:util` `parseArgs` is also
extremely well represented in training data.

## Recommendation

**Staying on `parseArgs` is defensible**: the CLI logic at stake is ~80 lines,
both libraries would be border-collie's first runtime dependency, and neither
removes more code than it adds. The real pain a library would relieve is the
hand-maintained USAGE string and manual flag mapping.

**If a library is adopted, prefer stricli**, on three decisive facts:

1. **Typing is native, not bolted on**: stricli checks flag specs against the
   declared `Flags` type in core (flags docs); commander's `opts()` is
   `Record<string, any>` (typings/index.d.ts) and strong typing requires a second
   package (`@commander-js/extra-typings`). Both are zero-dep, so the footprint
   argument doesn't separate them — typing does.
2. **The execution contract matches this codebase**: `runApplication` returns
   `Promise<number>` and never calls `process.exit` (run.ts), and every invocation
   takes an injected context — the same return-a-code + DI pattern `src/cli.ts`
   and `run()` already use. commander defaults to owning `process.exit()` and
   needs `exitOverride`/`configureOutput` opt-outs in every test.
3. **Health is adequate on both sides** (both pushed 2026-07-24; 10 stricli
   releases vs 5 commander releases in the trailing year), so maintenance doesn't
   veto either.

The counterweight is the agent-familiarity argument above: if that is weighted
highest, commander (+extra-typings) is the safer pick — agents will write it
correctly from memory. Since that argument applies equally to keeping
`parseArgs`, the cheapest agent-safe option is the status quo, and the best
technical upgrade is stricli.
