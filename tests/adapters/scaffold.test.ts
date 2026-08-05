import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../../src/adapters/scaffold.js";
import { workerRunName } from "../../src/adapters/tracker.js";
import { SCAFFOLD_FILES } from "../../src/core/scaffold.js";
import {
  declaredRunName,
  pinIsAhead,
  pinnedCliVersion,
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

describe("loadTemplate", () => {
  it("reads this package's own scaffolded workflow files, byte for byte", () => {
    for (const relPath of SCAFFOLD_FILES) {
      const fromPackageRoot = readFileSync(relPath, "utf8");

      expect(loadTemplate(relPath)).toBe(fromPackageRoot);
    }
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
 * The guard on the version the templates pin (issue #93). `init` hands a
 * target repo these files verbatim, so the pin is what that repo runs until
 * it is re-scaffolded, and a pin naming a version that isn't on npm fails
 * every Tick with a 404.
 *
 * The invariant is one-sided on purpose: a pin *behind* package.json is the
 * normal state between `npm version` and the publish it precedes, so only a
 * pin that leads is an error. `pnpm run sync:version` closes the gap after a
 * release (README "Release process").
 */
describe("the scaffolded templates' pinned version", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
    .version as string;

  for (const relPath of SCAFFOLD_FILES) {
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
