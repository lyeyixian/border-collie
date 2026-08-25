---
verify:
  lint: pnpm run lint
  typecheck: pnpm run typecheck
  test: pnpm run test
  build: pnpm run build
  smoke: pnpm run smoke
---

# Verifying a change

These five commands are the whole gate. They are the same five the CI matrix
runs (`.github/workflows/gates.yml`) and the same five the release checklist
runs before it tags (`.claude/skills/release/SKILL.md`), so a branch that is
green here is green on the pull request.

They assume dependencies are installed — `pnpm install --frozen-lockfile`
once, then the gate is repeatable.

| Name | What it proves |
| --- | --- |
| `lint` | Biome's combined lint and format check over the tree. Reports without writing; `biome check --write .` applies the fixes. |
| `typecheck` | `tsc --noEmit` over the whole project, tests included. Wider than `build`, which only compiles `src`. |
| `test` | The Vitest suite, one shot. `pnpm run test:watch` is the watch-mode companion and is deliberately not part of the gate — it never exits. |
| `build` | Emits `dist/` from `tsconfig.build.json`. The `bin` entry points into it, so `smoke` depends on this having run. |
| `smoke` | Packs the tarball npm would publish, installs it cold into a temp directory, and drives `--help`, `--version` and `init` from there. |

`lint`, `typecheck` and `test` are independent and can run in any order, or at
once. `smoke` runs `build` itself, so running the two back to back compiles
twice; that is cheap and keeps each command standalone.

## What `smoke` needs

`smoke` is the only command here that reaches outside the repository. It runs
`npm pack`, then `npm install` on the resulting tarball, so it needs network
access to resolve the runtime dependencies. It stubs out the `claude` binary
that `init` would otherwise spawn, so it costs no API credit.

Everything it creates — the tarball in the repository root, the install
directory, the scaffolded target repository — it removes on the way out,
including on failure. If a run is interrupted hard enough to skip the trap,
look for a stray `border-collie-*.tgz` at the root and `tmp.*` directories
under `$TMPDIR`.
