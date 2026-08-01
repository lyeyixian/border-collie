import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../../src/adapters/scaffold.js";
import { pinnedCliVersion, SCAFFOLD_FILES } from "../../src/core/scaffold.js";

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
 * The drift guard for the version the templates pin (issue #93). `init` hands
 * a target repo these files verbatim, so the pin is what that repo will run
 * forever after — and a pin naming a version this package isn't would either
 * install code the operator never scaffolded or fail outright. Nothing about
 * a bumped package.json updates a yml on its own, so the invariant is checked
 * here and kept true mechanically by `pnpm run sync:version` (the `version`
 * lifecycle script, README "Release process").
 */
describe("the scaffolded templates' pinned version", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8"))
    .version as string;

  for (const relPath of SCAFFOLD_FILES) {
    it(`matches this package's own version in ${relPath}`, () => {
      expect(pinnedCliVersion(loadTemplate(relPath))).toBe(packageVersion);
    });
  }
});
