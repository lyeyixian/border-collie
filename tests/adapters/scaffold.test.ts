import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileExists,
  loadTemplate,
  writeScaffoldFile,
} from "../../src/adapters/scaffold.js";
import { SCAFFOLD_FILES } from "../../src/core/scaffold.js";

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
