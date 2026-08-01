import { describe, expect, it } from "vitest";
import {
  ConfigError,
  modelForAttempt,
  resolveConfig,
  resolveWorkerConfig,
} from "../../src/core/config.js";

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
      maxOpenPrs: 5,
      pollSeconds: 30,
      maxTurns: 200,
      maxCostUsd: 20,
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
      maxOpenPrs: 5,
      pollSeconds: 30,
      maxTurns: 200,
      maxCostUsd: 20,
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
      maxOpenPrs: 5,
      pollSeconds: 30,
      maxTurns: 200,
      maxCostUsd: 20,
    });
  });

  it("requires an explicit all flag for repo-wide scope", () => {
    const resolved = resolveConfig({ max_workers: 2 }, { all: true });

    expect(resolved).toMatchObject({
      scope: { kind: "all" },
      maxWorkers: 2,
      model: "sonnet",
    });
  });

  it("takes the worker model from the config file", () => {
    const resolved = resolveConfig({ parent: 1, worker_model: "opus" }, {});

    expect(resolved.model).toBe("opus");
  });

  it("rejects a worker model that is not a non-empty string", () => {
    expect(() => resolveConfig({ parent: 1, worker_model: "" }, {})).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ parent: 1, worker_model: 4 }, {})).toThrow(
      ConfigError,
    );
  });

  it("takes the retry model from the config file, with a flag override", () => {
    expect(
      resolveConfig({ parent: 1, retry_model: "sonnet" }, {}).retryModel,
    ).toBe("sonnet");
    expect(
      resolveConfig(
        { parent: 1, retry_model: "sonnet" },
        { retryModel: "haiku" },
      ).retryModel,
    ).toBe("haiku");
  });

  it("rejects a retry model that is not a non-empty string", () => {
    expect(() => resolveConfig({ parent: 1, retry_model: "" }, {})).toThrow(
      ConfigError,
    );
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
    expect(() =>
      resolveConfig({ parent: 1, worker_timeout_minutes: 0 }, {}),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ parent: 1, worker_stall_minutes: -1 }, {}),
    ).toThrow(ConfigError);
  });

  it("lets a --timeout-minutes flag override the config file's Worker timeout", () => {
    expect(
      resolveConfig(
        { parent: 1, worker_timeout_minutes: 90 },
        { timeoutMinutes: 50 },
      ).timeoutMinutes,
    ).toBe(50);
  });

  it("takes the Worker budget backstops from the config file, allowing a fractional cost cap", () => {
    const resolved = resolveConfig(
      { parent: 1, worker_max_turns: 80, worker_max_cost_usd: 7.5 },
      {},
    );

    expect(resolved.maxTurns).toBe(80);
    expect(resolved.maxCostUsd).toBe(7.5);
  });

  it("rejects non-positive or non-numeric budget backstops", () => {
    expect(() => resolveConfig({ parent: 1, worker_max_turns: 0 }, {})).toThrow(
      ConfigError,
    );
    expect(() =>
      resolveConfig({ parent: 1, worker_max_turns: 1.5 }, {}),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ parent: 1, worker_max_cost_usd: -2 }, {}),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ parent: 1, worker_max_cost_usd: "20" }, {}),
    ).toThrow(ConfigError);
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

  it("takes max_open_prs and poll_seconds from the config file", () => {
    const resolved = resolveConfig(
      { parent: 1, max_open_prs: 2, poll_seconds: 60 },
      {},
    );

    expect(resolved.maxOpenPrs).toBe(2);
    expect(resolved.pollSeconds).toBe(60);
  });

  it("lets flags override max_open_prs and poll_seconds", () => {
    const resolved = resolveConfig(
      { parent: 1, max_open_prs: 2, poll_seconds: 60 },
      { maxOpenPrs: 8, pollSeconds: 10 },
    );

    expect(resolved.maxOpenPrs).toBe(8);
    expect(resolved.pollSeconds).toBe(10);
  });

  it("rejects a non-positive max_open_prs or poll_seconds", () => {
    expect(() => resolveConfig({ parent: 1, max_open_prs: 0 }, {})).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ parent: 1 }, { pollSeconds: 0 })).toThrow(
      ConfigError,
    );
  });

  it("resolves the working-hours window from the config file", () => {
    const resolved = resolveConfig(
      {
        parent: 1,
        timezone: "Europe/London",
        work_start_hour: 9,
        work_end_hour: 18,
      },
      {},
    );

    expect(resolved.workingHours).toEqual({
      timezone: "Europe/London",
      startHour: 9,
      endHour: 18,
    });
  });

  it("leaves the working-hours gate unconfigured when the file omits it", () => {
    const resolved = resolveConfig({ parent: 1 }, {});

    expect(resolved.workingHours).toBeUndefined();
  });

  it("rejects a partial working-hours window", () => {
    expect(() =>
      resolveConfig({ parent: 1, timezone: "Europe/London" }, {}),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ parent: 1, work_start_hour: 9, work_end_hour: 18 }, {}),
    ).toThrow(ConfigError);
  });

  it("rejects an unrecognized timezone", () => {
    expect(() =>
      resolveConfig(
        {
          parent: 1,
          timezone: "Not/AZone",
          work_start_hour: 9,
          work_end_hour: 18,
        },
        {},
      ),
    ).toThrow(ConfigError);
  });

  it("rejects an out-of-range or non-integer working hour", () => {
    expect(() =>
      resolveConfig(
        { parent: 1, timezone: "UTC", work_start_hour: 24, work_end_hour: 18 },
        {},
      ),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig(
        {
          parent: 1,
          timezone: "UTC",
          work_start_hour: 9.5,
          work_end_hour: 18,
        },
        {},
      ),
    ).toThrow(ConfigError);
  });

  it("rejects equal start and end working hours", () => {
    expect(() =>
      resolveConfig(
        { parent: 1, timezone: "UTC", work_start_hour: 9, work_end_hour: 9 },
        {},
      ),
    ).toThrow(ConfigError);
  });

  it("rejects a malformed config file", () => {
    expect(() => resolveConfig("not an object", {})).toThrow(ConfigError);
    expect(() => resolveConfig({ parent: "one" }, {})).toThrow(ConfigError);
    expect(() => resolveConfig({ max_workers: "many" }, { all: true })).toThrow(
      ConfigError,
    );
  });
});

describe("resolveWorkerConfig", () => {
  it("resolves with no config file and no scope flags at all (issue #71: a Worker attempt needs no Scope)", () => {
    const resolved = resolveWorkerConfig(undefined, {});

    expect(resolved).toEqual({
      maxWorkers: 3,
      maxOpenPrs: 5,
      pollSeconds: 30,
      model: "sonnet",
      retryModel: "opus",
      timeoutMinutes: 45,
      stallMinutes: 10,
      maxTurns: 200,
      maxCostUsd: 20,
    });
    expect(resolved).not.toHaveProperty("scope");
  });

  it("ignores a parent in the config file — no scope is ever resolved", () => {
    const resolved = resolveWorkerConfig({ parent: 1 }, {});

    expect(resolved).not.toHaveProperty("scope");
  });

  it("lets --model and --retry-model override the config file", () => {
    const resolved = resolveWorkerConfig(
      { worker_model: "haiku" },
      { model: "opus", retryModel: "haiku" },
    );

    expect(resolved.model).toBe("opus");
    expect(resolved.retryModel).toBe("haiku");
  });

  it("lets --timeout-minutes override the config file's Worker timeout", () => {
    const resolved = resolveWorkerConfig(
      { worker_timeout_minutes: 90 },
      { timeoutMinutes: 50 },
    );

    expect(resolved.timeoutMinutes).toBe(50);
  });

  it("takes the Worker timeout, stall window, and budget backstops from the config file", () => {
    const resolved = resolveWorkerConfig(
      {
        worker_timeout_minutes: 90,
        worker_stall_minutes: 5,
        worker_max_turns: 80,
        worker_max_cost_usd: 7.5,
      },
      {},
    );

    expect(resolved.timeoutMinutes).toBe(90);
    expect(resolved.stallMinutes).toBe(5);
    expect(resolved.maxTurns).toBe(80);
    expect(resolved.maxCostUsd).toBe(7.5);
  });

  it("rejects a malformed config file the same way resolveConfig does", () => {
    expect(() => resolveWorkerConfig("not an object", {})).toThrow(ConfigError);
    expect(() => resolveWorkerConfig({ worker_model: "" }, {})).toThrow(
      ConfigError,
    );
  });

  it("resolves the working-hours window the same way resolveConfig does", () => {
    const resolved = resolveWorkerConfig(
      { timezone: "Europe/London", work_start_hour: 9, work_end_hour: 18 },
      {},
    );

    expect(resolved.workingHours).toEqual({
      timezone: "Europe/London",
      startHour: 9,
      endHour: 18,
    });
  });
});
