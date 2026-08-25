import { describe, expect, it } from "vitest";
import { RUN_DIR } from "../../src/core/types.js";
import {
  ContractError,
  parseContract,
  resolveDockerfilePath,
  verifyCommandOutcome,
  verifyOutcome,
} from "../../src/core/workflow.js";

describe("parseContract", () => {
  it("parses both keys, with the declared commands readable by name", () => {
    const contract = parseContract(
      [
        "---",
        "after_create: |",
        "  corepack enable",
        "  pnpm install --frozen-lockfile",
        "verify:",
        "  lint: pnpm lint",
        "  typecheck: pnpm typecheck",
        "---",
        "",
        "# Prose for humans",
      ].join("\n"),
    );

    expect(contract.afterCreate).toBe(
      "corepack enable\npnpm install --frozen-lockfile",
    );
    expect(contract.verify.lint).toBe("pnpm lint");
    expect(contract.verify.typecheck).toBe("pnpm typecheck");
    expect(Object.keys(contract.verify)).toEqual(["lint", "typecheck"]);
  });

  it("accepts an inline (non-block) after_create", () => {
    const contract = parseContract(
      ["---", "after_create: pnpm install", "---"].join("\n"),
    );

    expect(contract.afterCreate).toBe("pnpm install");
  });

  it("parses as an empty contract when there is no front matter", () => {
    const contract = parseContract("# just a README, no front matter\n");

    expect(contract).toEqual({
      afterCreate: undefined,
      verify: {},
      dockerfile: undefined,
    });
  });

  it("parses as an empty contract when the front matter itself is blank", () => {
    const contract = parseContract(["---", "", "---", "body"].join("\n"));

    expect(contract).toEqual({
      afterCreate: undefined,
      verify: {},
      dockerfile: undefined,
    });
  });

  it("parses a declared dockerfile path", () => {
    const contract = parseContract(
      ["---", "dockerfile: docker/agent.Dockerfile", "---"].join("\n"),
    );

    expect(contract.dockerfile).toBe("docker/agent.Dockerfile");
  });

  it("leaves dockerfile undefined when the key is absent", () => {
    const contract = parseContract(
      ["---", "verify:", "  test: pnpm test", "---"].join("\n"),
    );

    expect(contract.dockerfile).toBeUndefined();
  });

  it("accepts an empty verify: map", () => {
    const contract = parseContract(
      ["---", "after_create: pnpm install", "verify:", "---"].join("\n"),
    );

    expect(contract.verify).toEqual({});
  });

  it("accepts a contract with no verify: key at all", () => {
    const contract = parseContract(
      ["---", "after_create: pnpm install", "---"].join("\n"),
    );

    expect(contract.verify).toEqual({});
  });

  it.each(["before_run", "after_run", "before_remove"])(
    "rejects %s, naming the offending key",
    (key) => {
      expect(() =>
        parseContract(["---", `${key}: echo hi`, "---"].join("\n")),
      ).toThrow(ContractError);
      expect(() =>
        parseContract(["---", `${key}: echo hi`, "---"].join("\n")),
      ).toThrow(new RegExp(key));
    },
  );

  it("rejects an unrelated unsupported key, naming it", () => {
    expect(() =>
      parseContract(["---", "some_other_key: value", "---"].join("\n")),
    ).toThrow(/some_other_key/);
  });

  it("rejects front matter that is a scalar rather than a map", () => {
    expect(() =>
      parseContract(["---", "just some prose", "---"].join("\n")),
    ).toThrow(ContractError);
  });

  it("rejects front matter that is a sequence rather than a map", () => {
    expect(() =>
      parseContract(["---", "- one", "- two", "---"].join("\n")),
    ).toThrow(ContractError);
  });

  it("never returns the Markdown body, and never fails on account of its content", () => {
    const withWeirdBody = parseContract(
      [
        "---",
        "verify:",
        "  test: pnpm test",
        "---",
        "",
        "This body mentions after_create: and verify: as prose, and even a",
        "before_run: line — none of it is YAML here, and none of it is parsed.",
      ].join("\n"),
    );

    expect(withWeirdBody).toEqual({
      afterCreate: undefined,
      verify: { test: "pnpm test" },
      dockerfile: undefined,
    });
    expect(withWeirdBody).not.toHaveProperty("body");
  });
});

describe("resolveDockerfilePath", () => {
  it("uses the declared path verbatim, marked as declared", () => {
    expect(resolveDockerfilePath("docker/agent.Dockerfile")).toEqual({
      path: "docker/agent.Dockerfile",
      declared: true,
    });
  });

  it("falls back to a default path under the fleet's own directory when nothing is declared", () => {
    expect(resolveDockerfilePath(undefined)).toEqual({
      path: `${RUN_DIR}/Dockerfile`,
      declared: false,
    });
  });

  it("never falls back to the repository's own root Dockerfile", () => {
    expect(resolveDockerfilePath(undefined).path).not.toBe("Dockerfile");
  });
});

describe("verifyOutcome", () => {
  it("is ok only when every command exited zero", () => {
    const passing = verifyOutcome([
      verifyCommandOutcome("lint", "pnpm lint", 0),
      verifyCommandOutcome("test", "pnpm test", 0),
    ]);
    const failing = verifyOutcome([
      verifyCommandOutcome("lint", "pnpm lint", 0),
      verifyCommandOutcome("test", "pnpm test", 1),
    ]);

    expect(passing.ok).toBe(true);
    expect(failing.ok).toBe(false);
    expect(failing.commands[1]).toEqual({
      name: "test",
      command: "pnpm test",
      exitCode: 1,
      ok: false,
    });
  });

  it("is ok (vacuously) with no commands at all", () => {
    expect(verifyOutcome([]).ok).toBe(true);
  });
});
