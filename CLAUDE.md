# border-collie

An orchestration loop that implements tracer-bullet tickets with a fleet of Claude Code agents.

## Source layout

- `src/core` — pure functions, no I/O.
- `src/adapters` — I/O: GitHub, filesystem, the Worker process.
- `src/app` — wires core and adapters together.
- `src/cli` — delivery: the command application and its composition-root context module.

Each layer may depend only on the layers listed above it; `cli` may also reach `adapters` directly, from its context module only. See `docs/adr/0005-functional-core-imperative-shell-not-clean-architecture.md` for why.

## Commit messages

Follow Conventional Commits: `type(scope): subject`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`. Scope optional. Subject imperative, lowercase, no trailing period. Same format for PR titles (they become merge-commit subjects).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (lyeyixian/border-collie) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Vendored Worker skills

`.claude/skills/{implement,tdd,code-review,codebase-design}` are vendored copies of upstream `mattpocock/skills`, scaffolded into target repositories by `init`. Keep them byte-identical to upstream — re-vendor rather than edit. See `docs/adr/0008-vendor-worker-skills-not-install-at-run-time.md`. `.claude/skills/release` is this repo's own and is never scaffolded.

`docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md` are scaffolded too, and they are *not* upstream copies — they are this repo's own, edited freely. Editing either changes what every newly onboarded repository receives, so read them as shipped content rather than as notes to ourselves. Anything scaffolded is listed in `SCAFFOLD_FILES` (`src/core/scaffold.ts`) and must appear in `package.json` "files"; a guard in `tests/adapters/scaffold.test.ts` enforces that, and `scripts/smoke.sh` proves it against the real tarball.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
