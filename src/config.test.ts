import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("takes the scope parent and max_workers from the config file", () => {
    const resolved = resolveConfig({ parent: 1, max_workers: 5 }, {});

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 1 },
      maxWorkers: 5,
    });
  });

  it("defaults max_workers to 3", () => {
    const resolved = resolveConfig({ parent: 1 }, {});

    expect(resolved.maxWorkers).toBe(3);
  });

  it("lets flags override the config file", () => {
    const resolved = resolveConfig(
      { parent: 1, max_workers: 5 },
      { parent: 4, maxWorkers: 2 },
    );

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 4 },
      maxWorkers: 2,
    });
  });

  it("works with flags alone when there is no config file", () => {
    const resolved = resolveConfig(undefined, { parent: 9 });

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 9 },
      maxWorkers: 3,
    });
  });

  it("requires an explicit all flag for repo-wide scope", () => {
    const resolved = resolveConfig({ max_workers: 2 }, { all: true });

    expect(resolved).toEqual({ scope: { kind: "all" }, maxWorkers: 2 });
  });

  it("rejects a run with neither a parent nor the all flag", () => {
    expect(() => resolveConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveConfig(undefined, {})).toThrow(ConfigError);
  });

  it("rejects combining a parent flag with the all flag", () => {
    expect(() => resolveConfig({}, { parent: 1, all: true })).toThrow(
      ConfigError,
    );
  });

  it("ignores a config-file parent when the all flag is given", () => {
    const resolved = resolveConfig({ parent: 1 }, { all: true });

    expect(resolved.scope).toEqual({ kind: "all" });
  });

  it("rejects a non-positive max_workers", () => {
    expect(() => resolveConfig({ parent: 1, max_workers: 0 }, {})).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ parent: 1 }, { maxWorkers: -2 })).toThrow(
      ConfigError,
    );
  });

  it("rejects a malformed config file", () => {
    expect(() => resolveConfig("not an object", {})).toThrow(ConfigError);
    expect(() => resolveConfig({ parent: "one" }, {})).toThrow(ConfigError);
    expect(() => resolveConfig({ max_workers: "many" }, { all: true })).toThrow(
      ConfigError,
    );
  });
});
