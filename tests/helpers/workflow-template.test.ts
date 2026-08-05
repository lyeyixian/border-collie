import { describe, expect, it } from "vitest";
import {
  declaredRunName,
  pinIsAhead,
  pinnedCliVersion,
} from "./workflow-template.js";

describe("pinnedCliVersion", () => {
  it("reads the version a template pins the orchestrator to", () => {
    const template = [
      "      - name: Install border-collie",
      "        run: npm install -g border-collie@1.2.3",
    ].join("\n");

    expect(pinnedCliVersion(template)).toBe("1.2.3");
  });

  it("is null for a template that installs nothing", () => {
    expect(pinnedCliVersion("name: Worker\n")).toBeNull();
  });

  it("ignores another package's pin on a neighbouring line", () => {
    const template = [
      "        run: npm install -g @anthropic-ai/claude-code@latest",
      "        run: npm install -g border-collie@0.9.0",
    ].join("\n");

    expect(pinnedCliVersion(template)).toBe("0.9.0");
  });

  it("is null when the install floats instead of pinning", () => {
    expect(pinnedCliVersion("run: npm install -g border-collie\n")).toBeNull();
  });
});

describe("pinIsAhead", () => {
  it("is false for a pin this package has exactly reached", () => {
    expect(pinIsAhead("0.3.0", "0.3.0")).toBe(false);
  });

  it("is false for a pin lagging behind, the normal state mid-release", () => {
    expect(pinIsAhead("0.3.0", "0.3.1")).toBe(false);
    expect(pinIsAhead("0.9.9", "1.0.0")).toBe(false);
  });

  it("is true for a pin naming a version that cannot be on npm yet", () => {
    expect(pinIsAhead("0.3.1", "0.3.0")).toBe(true);
    expect(pinIsAhead("1.0.0", "0.9.9")).toBe(true);
  });

  it("compares numerically, not as strings", () => {
    expect(pinIsAhead("0.10.0", "0.9.0")).toBe(true);
    expect(pinIsAhead("0.9.0", "0.10.0")).toBe(false);
  });

  it("compares a prerelease on its release triple", () => {
    expect(pinIsAhead("0.4.0-beta.1", "0.4.0")).toBe(false);
    expect(pinIsAhead("0.5.0-beta.1", "0.4.0")).toBe(true);
  });
});

describe("declaredRunName", () => {
  it("reads a quoted run-name with the quotes stripped", () => {
    const template = [
      "name: Worker",
      'run-name: "border-collie worker #5 attempt 1"',
    ].join("\n");

    expect(declaredRunName(template)).toBe("border-collie worker #5 attempt 1");
  });

  it("is null for a workflow declaring none", () => {
    expect(declaredRunName("name: Worker\n")).toBeNull();
  });

  it("returns an unquoted name truncated at a `#` as YAML itself reads it, rather than repairing it", () => {
    const template = "run-name: border-collie worker #5 attempt 1\n";

    expect(declaredRunName(template)).toBe("border-collie worker");
  });

  it("ignores a run-name-looking key nested under a job", () => {
    const template = ["jobs:", "  worker:", "    run-name: nope"].join("\n");

    expect(declaredRunName(template)).toBeNull();
  });
});
