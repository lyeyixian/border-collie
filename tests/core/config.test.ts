import { describe, expect, it } from "vitest";
import {
  ConfigError,
  modelForAttempt,
  resolveConfig,
  resolveWorkerConfig,
  type Scope,
  scopeFromFlags,
} from "../../src/core/config.js";

const PARENT_SCOPE: Scope = { kind: "parent", parent: 1 };

describe("scopeFromFlags", () => {
  it("defers to the tracker's Scope label when neither --parent nor --all is given", () => {
    expect(scopeFromFlags({})).toBeUndefined();
  });

  it("resolves --parent to a parent Scope, overriding whatever the tracker says", () => {
    expect(scopeFromFlags({ parent: 9 })).toEqual({
      kind: "parent",
      parent: 9,
    });
  });

  it("requires the explicit --all flag for repo-wide scope", () => {
    expect(scopeFromFlags({ all: true })).toEqual({ kind: "all" });
  });

  it("rejects combining --parent with --all", () => {
    expect(() => scopeFromFlags({ parent: 1, all: true })).toThrow(ConfigError);
  });

  it("rejects a non-positive --parent", () => {
    expect(() => scopeFromFlags({ parent: 0 })).toThrow(ConfigError);
    expect(() => scopeFromFlags({ parent: -2 })).toThrow(ConfigError);
  });
});

describe("resolveConfig", () => {
  it("attaches the given Scope to the resolved config verbatim", () => {
    expect(resolveConfig({}, {}, PARENT_SCOPE).scope).toEqual(PARENT_SCOPE);
    expect(resolveConfig({}, {}, { kind: "all" }).scope).toEqual({
      kind: "all",
    });
  });

  it("takes max_workers from the config file", () => {
    const resolved = resolveConfig({ max_workers: 5 }, {}, PARENT_SCOPE);

    expect(resolved).toEqual({
      scope: PARENT_SCOPE,
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
    const resolved = resolveConfig({}, {}, PARENT_SCOPE);

    expect(resolved.maxWorkers).toBe(3);
  });

  it("lets flags override the config file", () => {
    const resolved = resolveConfig(
      { max_workers: 5, worker_model: "haiku" },
      { maxWorkers: 2, model: "opus" },
      PARENT_SCOPE,
    );

    expect(resolved).toEqual({
      scope: PARENT_SCOPE,
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
    const resolved = resolveConfig(undefined, {}, PARENT_SCOPE);

    expect(resolved).toEqual({
      scope: PARENT_SCOPE,
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

  it("takes the worker model from the config file", () => {
    const resolved = resolveConfig({ worker_model: "opus" }, {}, PARENT_SCOPE);
    expect(resolved.model).toBe("opus");
  });

  it("rejects a worker model that is not a non-empty string", () => {
    expect(() => resolveConfig({ worker_model: "" }, {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ worker_model: 4 }, {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("takes the retry model from the config file, with a flag override", () => {
    expect(
      resolveConfig({ retry_model: "sonnet" }, {}, PARENT_SCOPE).retryModel,
    ).toBe("sonnet");
    expect(
      resolveConfig(
        { retry_model: "sonnet" },
        { retryModel: "haiku" },
        PARENT_SCOPE,
      ).retryModel,
    ).toBe("haiku");
  });

  it("rejects a retry model that is not a non-empty string", () => {
    expect(() => resolveConfig({ retry_model: "" }, {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("takes the Worker timeout and stall windows from the config file", () => {
    const resolved = resolveConfig(
      { worker_timeout_minutes: 90, worker_stall_minutes: 5 },
      {},
      PARENT_SCOPE,
    );

    expect(resolved.timeoutMinutes).toBe(90);
    expect(resolved.stallMinutes).toBe(5);
  });

  it("rejects non-positive timeout and stall windows", () => {
    expect(() =>
      resolveConfig({ worker_timeout_minutes: 0 }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ worker_stall_minutes: -1 }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
  });

  it("lets a --timeout-minutes flag override the config file's Worker timeout", () => {
    expect(
      resolveConfig(
        { worker_timeout_minutes: 90 },
        { timeoutMinutes: 50 },
        PARENT_SCOPE,
      ).timeoutMinutes,
    ).toBe(50);
  });

  it("takes the Worker budget backstops from the config file, allowing a fractional cost cap", () => {
    const resolved = resolveConfig(
      { worker_max_turns: 80, worker_max_cost_usd: 7.5 },
      {},
      PARENT_SCOPE,
    );

    expect(resolved.maxTurns).toBe(80);
    expect(resolved.maxCostUsd).toBe(7.5);
  });

  it("rejects non-positive or non-numeric budget backstops", () => {
    expect(() =>
      resolveConfig({ worker_max_turns: 0 }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ worker_max_turns: 1.5 }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ worker_max_cost_usd: -2 }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ worker_max_cost_usd: "20" }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
  });

  it("binds attempt one to the base model and later attempts to the retry model", () => {
    const config = resolveConfig({}, {}, PARENT_SCOPE);

    expect(modelForAttempt(config, 1)).toBe("sonnet");
    expect(modelForAttempt(config, 2)).toBe("opus");
  });

  it("rejects a non-positive max_workers", () => {
    expect(() => resolveConfig({ max_workers: 0 }, {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({}, { maxWorkers: -2 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("takes max_open_prs and poll_seconds from the config file", () => {
    const resolved = resolveConfig(
      { max_open_prs: 2, poll_seconds: 60 },
      {},
      PARENT_SCOPE,
    );

    expect(resolved.maxOpenPrs).toBe(2);
    expect(resolved.pollSeconds).toBe(60);
  });

  it("lets flags override max_open_prs and poll_seconds", () => {
    const resolved = resolveConfig(
      { max_open_prs: 2, poll_seconds: 60 },
      { maxOpenPrs: 8, pollSeconds: 10 },
      PARENT_SCOPE,
    );

    expect(resolved.maxOpenPrs).toBe(8);
    expect(resolved.pollSeconds).toBe(10);
  });

  it("rejects a non-positive max_open_prs or poll_seconds", () => {
    expect(() => resolveConfig({ max_open_prs: 0 }, {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({}, { pollSeconds: 0 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("resolves the working-hours window from the config file", () => {
    const resolved = resolveConfig(
      {
        timezone: "Europe/London",
        work_start_hour: 9,
        work_end_hour: 18,
      },
      {},
      PARENT_SCOPE,
    );

    expect(resolved.workingHours).toEqual({
      timezone: "Europe/London",
      startHour: 9,
      endHour: 18,
    });
  });

  it("leaves the working-hours gate unconfigured when the file omits it", () => {
    const resolved = resolveConfig({}, {}, PARENT_SCOPE);

    expect(resolved.workingHours).toBeUndefined();
  });

  it("rejects a partial working-hours window", () => {
    expect(() =>
      resolveConfig({ timezone: "Europe/London" }, {}, PARENT_SCOPE),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig(
        { work_start_hour: 9, work_end_hour: 18 },
        {},
        PARENT_SCOPE,
      ),
    ).toThrow(ConfigError);
  });

  it("rejects an unrecognized timezone", () => {
    expect(() =>
      resolveConfig(
        {
          timezone: "Not/AZone",
          work_start_hour: 9,
          work_end_hour: 18,
        },
        {},
        PARENT_SCOPE,
      ),
    ).toThrow(ConfigError);
  });

  it("rejects an out-of-range or non-integer working hour", () => {
    expect(() =>
      resolveConfig(
        { timezone: "UTC", work_start_hour: 24, work_end_hour: 18 },
        {},
        PARENT_SCOPE,
      ),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig(
        { timezone: "UTC", work_start_hour: 9.5, work_end_hour: 18 },
        {},
        PARENT_SCOPE,
      ),
    ).toThrow(ConfigError);
  });

  it("rejects equal start and end working hours", () => {
    expect(() =>
      resolveConfig(
        { timezone: "UTC", work_start_hour: 9, work_end_hour: 9 },
        {},
        PARENT_SCOPE,
      ),
    ).toThrow(ConfigError);
  });

  it("rejects a malformed config file", () => {
    expect(() => resolveConfig("not an object", {}, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() =>
      resolveConfig({ max_workers: "many" }, {}, { kind: "all" }),
    ).toThrow(ConfigError);
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
