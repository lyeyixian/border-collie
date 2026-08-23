import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DECLARE_SIDECAR_FILE,
  type DeclareExclusion,
  parseDeclareSidecar,
} from "../core/declare.js";
import { RUN_DIR } from "../core/types.js";

/**
 * The declare sidecar's own I/O (issue #150): reading it back from the
 * fleet's local directory and clearing it once read. Parsing itself is pure
 * (core/declare.ts); this module is the filesystem side of it, the same
 * split `adapters/workflow.ts` keeps for the contract itself.
 */

/** Sidecar path relative to the target repo root — under the fleet's local directory (`RUN_DIR`), alongside transcripts and worktrees. */
export function declareSidecarPath(cwd: string): string {
  return join(cwd, RUN_DIR, DECLARE_SIDECAR_FILE);
}

/** File-read half of the sidecar seam, injectable for tests. */
export type LoadDeclareSidecar = (cwd: string) => Promise<DeclareExclusion[]>;

/** Read and parse the sidecar at the fleet's local directory; an absent file means the session excluded nothing. */
export const loadDeclareSidecar: LoadDeclareSidecar = async (cwd) => {
  let raw: string;
  try {
    raw = await readFile(declareSidecarPath(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseDeclareSidecar(raw).excluded;
};

/** Delete half of the seam, injectable for tests. */
export type ClearDeclareSidecar = (cwd: string) => Promise<void>;

/** Remove the sidecar once `declare` has read it — scratch, not part of the contract; an already-absent file is fine. */
export const clearDeclareSidecar: ClearDeclareSidecar = async (cwd) => {
  await unlink(declareSidecarPath(cwd)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
};
