import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearDeclareSidecar,
  declareSidecarPath,
  loadDeclareSidecar,
} from "../../src/adapters/declare.js";
import { DeclareSidecarError } from "../../src/core/declare.js";
import { RUN_DIR } from "../../src/core/types.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "border-collie-declare-test-"));
}

function writeSidecar(dir: string, content: string): void {
  const path = declareSidecarPath(dir);
  mkdirSync(join(dir, RUN_DIR), { recursive: true });
  writeFileSync(path, content);
}

describe("declareSidecarPath", () => {
  it("is under the fleet's local directory, alongside transcripts and worktrees", () => {
    expect(declareSidecarPath("/repo")).toBe(
      join("/repo", RUN_DIR, "declare-sidecar.json"),
    );
  });
});

describe("loadDeclareSidecar", () => {
  it("reads and parses the sidecar at the fleet's local directory", async () => {
    const dir = tmpRepo();
    writeSidecar(
      dir,
      JSON.stringify({ excluded: [{ name: "e2e", reason: "does not exist" }] }),
    );

    const excluded = await loadDeclareSidecar(dir);

    expect(excluded).toEqual([{ name: "e2e", reason: "does not exist" }]);
  });

  it("is an empty array when the repo has no sidecar", async () => {
    const dir = tmpRepo();

    await expect(loadDeclareSidecar(dir)).resolves.toEqual([]);
  });

  it("propagates a malformed sidecar as DeclareSidecarError", async () => {
    const dir = tmpRepo();
    writeSidecar(dir, "not json");

    await expect(loadDeclareSidecar(dir)).rejects.toThrow(DeclareSidecarError);
  });
});

describe("clearDeclareSidecar", () => {
  it("removes an existing sidecar", async () => {
    const dir = tmpRepo();
    writeSidecar(dir, '{"excluded":[]}');

    await clearDeclareSidecar(dir);

    expect(existsSync(declareSidecarPath(dir))).toBe(false);
  });

  it("is a no-op, not a throw, when there is no sidecar to clear", async () => {
    const dir = tmpRepo();

    await expect(clearDeclareSidecar(dir)).resolves.toBeUndefined();
  });

  it("leaves everything else in the fleet's local directory untouched", async () => {
    const dir = tmpRepo();
    writeSidecar(dir, '{"excluded":[]}');
    const sibling = join(dir, RUN_DIR, "transcripts", "declare.jsonl");
    mkdirSync(join(dir, RUN_DIR, "transcripts"), { recursive: true });
    writeFileSync(sibling, "hi");

    await clearDeclareSidecar(dir);

    expect(readFileSync(sibling, "utf8")).toBe("hi");
  });
});
