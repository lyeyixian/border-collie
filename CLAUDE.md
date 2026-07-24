# border-collie

An orchestration loop that implements tracer-bullet tickets with a fleet of Claude Code agents.

## Commit messages

Follow Conventional Commits: `type(scope): subject`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`. Scope optional. Subject imperative, lowercase, no trailing period. Same format for PR titles (they become merge-commit subjects).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (lyeyixian/border-collie) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
