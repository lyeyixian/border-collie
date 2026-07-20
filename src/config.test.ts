import { describe, expect, it } from "vitest";
import { ConfigError, modelForAttempt, resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("takes the scope parent and max_workers from the config file", () => {
    const resolved = resolveConfig({ parent: 1, max_workers: 5 }, {});

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 1 },
      maxWorkers: 5,
      model: "sonnet",
      retryModel: "opus",
      timeoutMinutes: 45,
      stallMinutes: 10,
    });
  });

  it("defaults max_workers to 3", () => {
    const resolved = resolveConfig({ parent: 1 }, {});

    expect(resolved.maxWorkers).toBe(3);
  });

  it("lets flags override the config file", () => {
    const resolved = resolveConfig(
      { parent: 1, max_workers: 5, worker_model: "haiku" },
      { parent: 4, maxWorkers: 2, model: "opus" },
    );

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 4 },
      maxWorkers: 2,
      model: "opus",
      retryModel: "opus",
      timeoutMinutes: 45,
      stallMinutes: 10,
    });
  });

  it("works with flags alone when there is no config file", () => {
    const resolved = resolveConfig(undefined, { parent: 9 });

    expect(resolved).toEqual({
      scope: { kind: "parent", parent: 9 },
      maxWorkers: 3,
      model: "sonnet",
      retryModel: "opus",
      timeoutMinutes: 45,
      stallMinutes: 10,
    });
  });

  it("requires an explicit all flag for repo-wide scope", () => {
    const resolved = resolveConfig({ max_workers: 2 }, { all: true });

    expect(resolved).toMatchObject({ scope: { kind: "all" }, maxWorkers: 2, model: "sonnet" });
  });

  it("takes the worker model from the config file", () => {
    const resolved = resolveConfig({ parent: 1, worker_model: "opus" }, {});

    expect(resolved.model).toBe("opus");
  });

  it("rejects a worker model that is not a non-empty string", () => {
    expect(() => resolveConfig({ parent: 1, worker_model: "" }, {})).toThrow(ConfigError);
    expect(() => resolveConfig({ parent: 1, worker_model: 4 }, {})).toThrow(ConfigError);
  });

  it("takes the retry model from the config file, with a flag override", () => {
    expect(resolveConfig({ parent: 1, retry_model: "sonnet" }, {}).retryModel).toBe("sonnet");
    expect(
      resolveConfig({ parent: 1, retry_model: "sonnet" }, { retryModel: "haiku" }).retryModel,
    ).toBe("haiku");
  });

  it("rejects a retry model that is not a non-empty string", () => {
    expect(() => resolveConfig({ parent: 1, retry_model: "" }, {})).toThrow(ConfigError);
  });

  it("takes the Worker timeout and stall windows from the config file", () => {
    const resolved = resolveConfig(
      { parent: 1, worker_timeout_minutes: 90, worker_stall_minutes: 5 },
      {},
    );

    expect(resolved.timeoutMinutes).toBe(90);
    expect(resolved.stallMinutes).toBe(5);
  });

  it("rejects non-positive timeout and stall windows", () => {
    expect(() => resolveConfig({ parent: 1, worker_timeout_minutes: 0 }, {})).toThrow(ConfigError);
    expect(() => resolveConfig({ parent: 1, worker_stall_minutes: -1 }, {})).toThrow(ConfigError);
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

  it("binds attempt one to the base model and later attempts to the retry model", () => {
    const config = resolveConfig({ parent: 1 }, {});

    expect(modelForAttempt(config, 1)).toBe("sonnet");
    expect(modelForAttempt(config, 2)).toBe("opus");
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
