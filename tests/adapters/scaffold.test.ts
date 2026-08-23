import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliVersion,
  fileExists,
  loadTemplate,
  readGitignore,
  writeScaffoldFile,
} from "../../src/adapters/scaffold.js";
import { workerRunName } from "../../src/adapters/tracker.js";
import {
  GITIGNORE_PATH,
  SCAFFOLD_FILES,
  SKILL_FILES,
  WORKFLOW_FILES,
} from "../../src/core/scaffold.js";
import { ORCHESTRATOR_LABELS } from "../../src/core/types.js";
import {
  declaredRunName,
  pinIsAhead,
  pinnedCliVersion,
  pluginCommands,
} from "../helpers/workflow-template.js";

describe("fileExists", () => {
  it("is false for a path that isn't there", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-scaffold-test-"));

    expect(fileExists(dir, ".github/workflows/border-collie-tick.yml")).toBe(
      false,
    );
  });

  it("is true once writeScaffoldFile has written the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-scaffold-test-"));

    writeScaffoldFile(dir, ".github/workflows/border-collie-tick.yml", "x");

    expect(fileExists(dir, ".github/workflows/border-collie-tick.yml")).toBe(
      true,
    );
  });
});

describe("writeScaffoldFile", () => {
  it("creates parent directories that don't exist yet and writes the content", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-scaffold-test-"));

    writeScaffoldFile(
      dir,
      ".github/workflows/border-collie-tick.yml",
      "name: border-collie Tick\n",
    );

    expect(
      readFileSync(
        join(dir, ".github/workflows/border-collie-tick.yml"),
        "utf8",
      ),
    ).toBe("name: border-collie Tick\n");
  });
});

describe("readGitignore", () => {
  it("is undefined when the repo has no .gitignore yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-scaffold-test-"));

    expect(readGitignore(dir)).toBeUndefined();
  });

  it("reads the repo's own .gitignore content", () => {
    const dir = mkdtempSync(join(tmpdir(), "border-collie-scaffold-test-"));
    writeFileSync(join(dir, GITIGNORE_PATH), "node_modules\n");

    expect(readGitignore(dir)).toBe("node_modules\n");
  });
});

describe("loadTemplate", () => {
  it("reads this package's own scaffolded workflow files, byte for byte", () => {
    for (const relPath of SCAFFOLD_FILES) {
      const fromPackageRoot = readFileSync(relPath, "utf8");

      expect(loadTemplate(relPath)).toBe(fromPackageRoot);
    }
  });
});

describe("cliVersion", () => {
  it("reads the version of the package this module ships in", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
      .version as string;

    expect(cliVersion()).toBe(packageVersion);
  });
});

/**
 * The guard on the one string that ties a running Worker's job back to its
 * Ticket (issue #111). `liveWorkerTickets` matches runs on their display
 * title because workflow_dispatch inputs are not readable off a run, so the
 * template's `run-name:` and `workerRunName` are two halves of one contract
 * that nothing else checks: the tracker's own unit tests build their fake
 * runs *with* `workerRunName`, so they stay green against a template that
 * declares no run-name at all — which is exactly how the fleet shipped for
 * a while, releasing live Workers' claims as orphaned every Tick.
 */
describe("the scaffolded Worker workflow's run-name", () => {
  const runName = declaredRunName(
    loadTemplate(".github/workflows/border-collie-worker.yml"),
  );

  it("declares one at all", () => {
    expect(runName).not.toBeNull();
  });

  it("renders, from its dispatch inputs, exactly the title liveWorkerTickets matches on", () => {
    const rendered = (runName as string)
      .replace(/\$\{\{\s*inputs\.ticket\s*\}\}/, "5")
      .replace(/\$\{\{\s*inputs\.attempt\s*\}\}/, "2");

    expect(rendered).toBe(workerRunName(5, 2));
  });
});

/**
 * The guard on the version the templates pin (issue #93) — which, since #99,
 * is the version *this repository's own fleet* runs, not the one a target
 * repo gets: `init` re-pins on the way out to the version of the CLI doing
 * the scaffolding (see tests/app/init.test.ts). A pin naming a version that
 * isn't on npm still fails every Tick here with a 404.
 *
 * The invariant is one-sided on purpose: a pin *behind* package.json is the
 * normal state between `npm version` and the publish it precedes, so only a
 * pin that leads is an error. `pnpm run sync:version` closes the gap after a
 * release (README "Release process").
 */
describe("the scaffolded templates' pinned version", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
    .version as string;

  for (const relPath of WORKFLOW_FILES) {
    describe(relPath, () => {
      const pin = pinnedCliVersion(loadTemplate(relPath));

      it("pins a version rather than floating", () => {
        expect(pin).not.toBeNull();
      });

      it("never names a version this package hasn't reached, which could not be on npm yet", () => {
        expect(pinIsAhead(pin as string, packageVersion)).toBe(false);
      });
    });
  }
});

/**
 * The guard on the run-time plugin install `init` replaced with vendored
 * files (issue #153). A `claude plugin install` inside a Worker job is a
 * floating install on an unattended fleet — the very failure the pinned CLI
 * install two steps above it exists to prevent — and it silently makes the
 * vendored closure beside it moot, since whatever upstream served that night
 * wins. Nothing else notices its return: the skills would still resolve, and
 * the pull request would look ordinary.
 */
describe("the scaffolded workflows' run-time installs", () => {
  for (const relPath of WORKFLOW_FILES) {
    it(`runs no Claude Code plugin command in ${relPath}`, () => {
      expect(pluginCommands(loadTemplate(relPath))).toEqual([]);
    });
  }
});

/** Every relative Markdown link a vendored file makes, as a scaffolded path. */
function linkedFiles(relPath: string): string[] {
  const links = loadTemplate(relPath).matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  return [...links]
    .map((match) => match[1] as string)
    .filter((target) => /^[^#:]+\.md$/.test(target))
    .map((target) => posix.join(posix.dirname(relPath), target));
}

/** Every `docs/agents/<name>.md` path a vendored file names in its prose. */
function referencedAgentDocs(relPath: string): string[] {
  const refs = loadTemplate(relPath).matchAll(/docs\/agents\/[\w.-]+\.md/g);
  return [...refs].map((match) => match[0]);
}

/**
 * The one skill the closure names but deliberately does not vendor (ADR 0008):
 * `/setup-matt-pocock-skills` is an interactive session, useless to a headless
 * Worker, and its whole output is the agent docs `init` writes directly.
 */
const UNVENDORED_SKILL = "setup-matt-pocock-skills";

/**
 * Every slash command a vendored file invokes, outside fenced code blocks —
 * inside one, a `fetch(\`/users/${id}\`)` in an example reads as an invocation.
 * The leading boundary rejects a path segment (`docs/agents`, `src/orders`)
 * for the same reason.
 */
function invokedSkills(relPath: string): string[] {
  const prose = loadTemplate(relPath).replace(/```[\s\S]*?```/g, "");
  const matches = prose.matchAll(/(?:^|[^\w.:/-])\/([a-z][a-z0-9-]{2,})/g);
  return [...new Set([...matches].map((match) => match[1] as string))];
}

/**
 * The guards on the closure itself (issue #153). Vendoring the one skill the
 * Worker prompt names, and none of what it reaches, leaves a session that
 * improvises halfway through — a failure that surfaces as an oddly-shaped
 * pull request rather than as an error, exactly like the missing skill this
 * replaced. Both readers work off the vendored files' own text, so a skill
 * re-vendored from a newer upstream that reaches somewhere new fails here
 * rather than at 3am in a Worker job.
 */
describe("the vendored skill closure", () => {
  for (const relPath of SKILL_FILES) {
    describe(relPath, () => {
      it("links only to files that are vendored alongside it", () => {
        for (const linked of linkedFiles(relPath)) {
          expect(SKILL_FILES).toContain(linked);
        }
      });

      it("names only agent docs the scaffold also writes", () => {
        for (const doc of referencedAgentDocs(relPath)) {
          expect(SCAFFOLD_FILES).toContain(doc);
        }
      });
    });
  }

  it("covers the support files the skills actually link to", () => {
    const linked = SKILL_FILES.flatMap(linkedFiles);

    expect(linked).toContain(".claude/skills/tdd/tests.md");
    expect(linked).toContain(".claude/skills/tdd/mocking.md");
    expect(linked).toContain(".claude/skills/codebase-design/DEEPENING.md");
  });

  it("covers the tracker doc a vendored skill would otherwise send an unattended session to set up by hand", () => {
    expect(SKILL_FILES.flatMap(referencedAgentDocs)).toContain(
      "docs/agents/issue-tracker.md",
    );
  });

  /**
   * The guard that makes re-vendoring safe rather than merely correct today.
   * Without it a newer upstream in which `implement` grew a `/diagnosing-bugs`
   * call would pass every other test here and fail only in a Worker job, as
   * unhandled text a session improvises over.
   */
  for (const relPath of SKILL_FILES) {
    it(`invokes only skills vendored alongside ${relPath}`, () => {
      for (const skill of invokedSkills(relPath)) {
        if (skill === UNVENDORED_SKILL) continue;

        expect(SKILL_FILES).toContain(`.claude/skills/${skill}/SKILL.md`);
      }
    });
  }

  /**
   * ...and the guard above must actually be reading invocations, or it passes
   * by finding nothing at all.
   */
  it("reads the invocations the closure was derived from", () => {
    const invoked = SKILL_FILES.flatMap(invokedSkills);

    expect(invoked).toContain("tdd");
    expect(invoked).toContain("code-review");
    expect(invoked).toContain("codebase-design");
  });
});

/**
 * The guard on what the tarball actually carries. `SCAFFOLD_FILES` is read at
 * run time from the installed package root, so a scaffolded path missing from
 * package.json's "files" is invisible to every test in this repo — they all
 * read the source tree, where the file is present regardless — and surfaces
 * only as a cold `init` failing in a target repo. scripts/smoke.sh proves the
 * tarball end to end; this fails the moment the two lists diverge, without
 * packing anything.
 *
 * Exact paths rather than the directories that would also work: a directory
 * entry ships a file `SKILL_FILES` does not name, so an upstream file added
 * to a vendored skill would reach the tarball and never be scaffolded.
 */
describe('package.json "files"', () => {
  const published = JSON.parse(readFileSync("package.json", "utf8"))
    .files as string[];

  for (const relPath of SCAFFOLD_FILES) {
    it(`publishes ${relPath}`, () => {
      expect(published).toContain(relPath);
    });
  }
});

/**
 * The triage-label map is scaffolded into every onboarded repository and makes
 * a claim about which labels `init` creates, so it drifts silently: issue #156
 * renamed two of them and this doc kept the old names for a release. Only the
 * names are checked — the prose around them is the repository's to edit once
 * scaffolded.
 */
describe("the scaffolded triage-label map", () => {
  const doc = loadTemplate("docs/agents/triage-labels.md");

  for (const label of ORCHESTRATOR_LABELS) {
    it(`names ${label.name}, which init creates`, () => {
      expect(doc).toContain(label.name);
    });
  }
});
