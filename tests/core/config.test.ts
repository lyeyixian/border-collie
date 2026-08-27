import { describe, expect, it } from "vitest";
import { APP_ID_ENV, APP_PRIVATE_KEY_ENV } from "../../src/core/app-auth.js";
import {
  CLAUDE_CODE_OAUTH_TOKEN_ENV,
  ConfigError,
  type DaemonFlags,
  type FleetConfig,
  modelForAttempt,
  parseFleetConfig,
  resolveConfig,
  resolveDaemonConfig,
  resolveFleetPolicy,
  resolveWorkerConfig,
  type Scope,
  scopeFromFlags,
  TRANSCRIPT_RETENTION_DAYS_ENV,
  WORKER_IMAGE_ENV,
} from "../../src/core/config.js";
import { DEFAULT_TRANSCRIPT_RETENTION_MS } from "../../src/core/container.js";

const PARENT_SCOPE: Scope = { kind: "parent", parent: 1 };

const EMPTY_FLEET_CONFIG: FleetConfig = { defaults: {}, repositories: {} };

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
    expect(resolveConfig({}, PARENT_SCOPE).scope).toEqual(PARENT_SCOPE);
    expect(resolveConfig({}, { kind: "all" }).scope).toEqual({
      kind: "all",
    });
  });

  it("resolves every field to this package's built-in default with no flags", () => {
    const resolved = resolveConfig({}, PARENT_SCOPE);

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

  it("leaves the working-hours gate unconfigured — there is no flag surface for it locally, only the daemon's fleet policy file", () => {
    expect(resolveConfig({}, PARENT_SCOPE).workingHours).toBeUndefined();
  });

  it("lets flags override every default", () => {
    const resolved = resolveConfig(
      {
        maxWorkers: 2,
        maxOpenPrs: 8,
        pollSeconds: 10,
        model: "opus",
        retryModel: "haiku",
        timeoutMinutes: 50,
      },
      PARENT_SCOPE,
    );

    expect(resolved).toEqual({
      scope: PARENT_SCOPE,
      maxWorkers: 2,
      maxOpenPrs: 8,
      pollSeconds: 10,
      model: "opus",
      retryModel: "haiku",
      timeoutMinutes: 50,
      stallMinutes: 10,
      maxTurns: 200,
      maxCostUsd: 20,
    });
  });

  it("rejects a non-positive --max-workers, --max-open-prs, --poll-seconds or --timeout-minutes", () => {
    expect(() => resolveConfig({ maxWorkers: -2 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ maxOpenPrs: 0 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ pollSeconds: 0 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ timeoutMinutes: 0 }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("rejects an empty --model or --retry-model", () => {
    expect(() => resolveConfig({ model: "" }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ retryModel: "" }, PARENT_SCOPE)).toThrow(
      ConfigError,
    );
  });

  it("binds attempt one to the base model and later attempts to the retry model", () => {
    const config = resolveConfig({}, PARENT_SCOPE);

    expect(modelForAttempt(config, 1)).toBe("sonnet");
    expect(modelForAttempt(config, 2)).toBe("opus");
  });
});

describe("resolveWorkerConfig", () => {
  it("resolves with no scope flags at all (issue #71: a Worker attempt needs no Scope)", () => {
    const resolved = resolveWorkerConfig({});

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

  it("lets --model, --retry-model and --timeout-minutes override the defaults", () => {
    const resolved = resolveWorkerConfig({
      model: "opus",
      retryModel: "haiku",
      timeoutMinutes: 50,
    });

    expect(resolved.model).toBe("opus");
    expect(resolved.retryModel).toBe("haiku");
    expect(resolved.timeoutMinutes).toBe(50);
  });

  it("leaves the working-hours gate unconfigured, the same as resolveConfig", () => {
    expect(resolveWorkerConfig({}).workingHours).toBeUndefined();
  });
});

describe("parseFleetConfig", () => {
  it("treats a missing file as valid, yielding no defaults and no overrides", () => {
    expect(parseFleetConfig(undefined)).toEqual(EMPTY_FLEET_CONFIG);
  });

  it("parses fleet-wide defaults", () => {
    const parsed = parseFleetConfig({
      defaults: {
        max_workers: 5,
        max_open_prs: 8,
        worker_model: "haiku",
        retry_model: "sonnet",
        worker_timeout_minutes: 60,
        worker_stall_minutes: 15,
        worker_max_turns: 100,
        worker_max_cost_usd: 12.5,
        timezone: "Europe/London",
        work_start_hour: 20,
        work_end_hour: 6,
      },
    });

    expect(parsed).toEqual({
      defaults: {
        maxWorkers: 5,
        maxOpenPrs: 8,
        model: "haiku",
        retryModel: "sonnet",
        timeoutMinutes: 60,
        stallMinutes: 15,
        maxTurns: 100,
        maxCostUsd: 12.5,
        workingHours: {
          timezone: "Europe/London",
          startHour: 20,
          endHour: 6,
        },
      },
      repositories: {},
    });
  });

  it("parses per-repository overrides keyed by owner/name", () => {
    const parsed = parseFleetConfig({
      repositories: {
        "acme/website": { max_open_prs: 10 },
        "acme/internal-tools": { worker_model: "opus" },
      },
    });

    expect(parsed.repositories).toEqual({
      "acme/website": { maxOpenPrs: 10 },
      "acme/internal-tools": { model: "opus" },
    });
  });

  it("defaults an absent defaults or repositories section to empty", () => {
    expect(parseFleetConfig({})).toEqual(EMPTY_FLEET_CONFIG);
    expect(parseFleetConfig({ defaults: {} })).toEqual(EMPTY_FLEET_CONFIG);
    expect(parseFleetConfig({ repositories: {} })).toEqual(EMPTY_FLEET_CONFIG);
  });

  it("rejects a root that is not a JSON object", () => {
    expect(() => parseFleetConfig("not an object")).toThrow(ConfigError);
    expect(() => parseFleetConfig(["defaults"])).toThrow(ConfigError);
  });

  it("rejects an unknown top-level key rather than silently ignoring it", () => {
    expect(() => parseFleetConfig({ default: {} })).toThrow(ConfigError);
  });

  it("rejects repositories that is not a JSON object", () => {
    expect(() => parseFleetConfig({ repositories: "acme/website" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an unknown key inside defaults", () => {
    expect(() => parseFleetConfig({ defaults: { max_wokers: 5 } })).toThrow(
      ConfigError,
    );
  });

  it("rejects an unknown key inside a repository override", () => {
    expect(() =>
      parseFleetConfig({
        repositories: { "acme/website": { max_wokers: 5 } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a repository override that is not a JSON object", () => {
    expect(() =>
      parseFleetConfig({ repositories: { "acme/website": "many" } }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-positive or wrongly typed field the same way resolveConfig does", () => {
    expect(() => parseFleetConfig({ defaults: { max_workers: 0 } })).toThrow(
      ConfigError,
    );
    expect(() => parseFleetConfig({ defaults: { worker_model: "" } })).toThrow(
      ConfigError,
    );
    expect(() =>
      parseFleetConfig({ defaults: { worker_max_cost_usd: "20" } }),
    ).toThrow(ConfigError);
  });

  it("rejects a partial working-hours window", () => {
    expect(() =>
      parseFleetConfig({ defaults: { timezone: "Europe/London" } }),
    ).toThrow(ConfigError);
  });

  it("rejects an unrecognized timezone", () => {
    expect(() =>
      parseFleetConfig({
        defaults: {
          timezone: "Not/AZone",
          work_start_hour: 9,
          work_end_hour: 18,
        },
      }),
    ).toThrow(ConfigError);
  });
});

describe("resolveFleetPolicy", () => {
  it("falls all the way back to this package's built-in defaults when the file is empty", () => {
    expect(resolveFleetPolicy(EMPTY_FLEET_CONFIG, "acme/website")).toEqual({
      maxWorkers: 3,
      maxOpenPrs: 5,
      model: "sonnet",
      retryModel: "opus",
      timeoutMinutes: 45,
      stallMinutes: 10,
      maxTurns: 200,
      maxCostUsd: 20,
    });
  });

  it("applies the fleet-wide default to every repository that states no override", () => {
    const fleetConfig: FleetConfig = {
      defaults: { maxOpenPrs: 8 },
      repositories: {},
    };

    expect(resolveFleetPolicy(fleetConfig, "acme/website").maxOpenPrs).toBe(8);
    expect(
      resolveFleetPolicy(fleetConfig, "acme/internal-tools").maxOpenPrs,
    ).toBe(8);
  });

  it("lets a per-repository override win over the fleet-wide default", () => {
    const fleetConfig: FleetConfig = {
      defaults: { maxOpenPrs: 8 },
      repositories: { "acme/website": { maxOpenPrs: 20 } },
    };

    expect(resolveFleetPolicy(fleetConfig, "acme/website").maxOpenPrs).toBe(20);
    expect(
      resolveFleetPolicy(fleetConfig, "acme/internal-tools").maxOpenPrs,
    ).toBe(8);
  });

  it("falls back to the fleet-wide default field by field when the override states only some fields", () => {
    const fleetConfig: FleetConfig = {
      defaults: { maxOpenPrs: 8, model: "haiku" },
      repositories: { "acme/website": { maxOpenPrs: 20 } },
    };

    const resolved = resolveFleetPolicy(fleetConfig, "acme/website");
    expect(resolved.maxOpenPrs).toBe(20);
    expect(resolved.model).toBe("haiku");
  });

  it("has no per-repository entry fall back to the built-in default, not the fleet-wide default, for a field the defaults never state", () => {
    const fleetConfig: FleetConfig = {
      defaults: { maxOpenPrs: 8 },
      repositories: { "acme/website": {} },
    };

    expect(resolveFleetPolicy(fleetConfig, "acme/website").maxWorkers).toBe(3);
  });

  it("is a pure function over already-parsed values — no I/O, called directly with plain objects", () => {
    const fleetConfig = parseFleetConfig({
      defaults: { max_open_prs: 8 },
      repositories: { "acme/website": { max_open_prs: 20 } },
    });

    expect(resolveFleetPolicy(fleetConfig, "acme/website").maxOpenPrs).toBe(20);
  });
});

describe("resolveDaemonConfig", () => {
  const ENV = {
    [APP_ID_ENV]: "123456",
    [APP_PRIVATE_KEY_ENV]: "-----BEGIN PRIVATE KEY-----",
    [CLAUDE_CODE_OAUTH_TOKEN_ENV]: "claude-token",
    [WORKER_IMAGE_ENV]: "ghcr.io/acme/border-collie-base:latest",
  };

  it("resolves every field from flags and environment, defaulting the state dir under the home directory and the fleet config path under the state dir", () => {
    const resolved = resolveDaemonConfig({}, ENV, "/home/operator");

    expect(resolved).toEqual({
      pollSeconds: 30,
      image: "ghcr.io/acme/border-collie-base:latest",
      stateDir: "/home/operator/.border-collie",
      appId: "123456",
      appPrivateKey: "-----BEGIN PRIVATE KEY-----",
      claudeCodeOAuthToken: "claude-token",
      probeModel: "sonnet",
      transcriptRetentionMs: DEFAULT_TRANSCRIPT_RETENTION_MS,
      fleetConfigPath: "/home/operator/.border-collie/fleet.json",
    });
  });

  it("lets flags override the poll interval, image, state dir and fleet config path", () => {
    const flags: DaemonFlags = {
      pollSeconds: 60,
      image: "ghcr.io/acme/other:latest",
      stateDir: "/srv/border-collie",
      fleetConfig: "/etc/border-collie/fleet.json",
    };

    const resolved = resolveDaemonConfig(flags, ENV, "/home/operator");

    expect(resolved.pollSeconds).toBe(60);
    expect(resolved.image).toBe("ghcr.io/acme/other:latest");
    expect(resolved.stateDir).toBe("/srv/border-collie");
    expect(resolved.fleetConfigPath).toBe("/etc/border-collie/fleet.json");
  });

  it("defaults the fleet config path under an overridden state dir when only --state-dir is given", () => {
    const resolved = resolveDaemonConfig(
      { stateDir: "/srv/border-collie" },
      ENV,
      "/home/operator",
    );

    expect(resolved.fleetConfigPath).toBe("/srv/border-collie/fleet.json");
  });

  it("lets a flag override the transcript retention window", () => {
    const resolved = resolveDaemonConfig(
      { transcriptRetentionDays: 7 },
      ENV,
      "/home/operator",
    );

    expect(resolved.transcriptRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("lets the environment override the transcript retention window when no flag is given", () => {
    const resolved = resolveDaemonConfig(
      {},
      { ...ENV, [TRANSCRIPT_RETENTION_DAYS_ENV]: "3" },
      "/home/operator",
    );

    expect(resolved.transcriptRetentionMs).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("a flag wins over the environment for the transcript retention window", () => {
    const resolved = resolveDaemonConfig(
      { transcriptRetentionDays: 7 },
      { ...ENV, [TRANSCRIPT_RETENTION_DAYS_ENV]: "3" },
      "/home/operator",
    );

    expect(resolved.transcriptRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("names an invalid transcript retention window rather than crashing", () => {
    expect(() =>
      resolveDaemonConfig(
        { transcriptRetentionDays: 0 },
        ENV,
        "/home/operator",
      ),
    ).toThrow(ConfigError);
  });

  it("names a malformed environment value for the transcript retention window, showing the bad input rather than a stray null", () => {
    expect(() =>
      resolveDaemonConfig(
        {},
        { ...ENV, [TRANSCRIPT_RETENTION_DAYS_ENV]: "abc" },
        "/home/operator",
      ),
    ).toThrow('got "abc"');
  });

  it("names a missing worker image rather than crashing", () => {
    const { [WORKER_IMAGE_ENV]: _omit, ...envWithoutImage } = ENV;

    expect(() =>
      resolveDaemonConfig({}, envWithoutImage, "/home/operator"),
    ).toThrow(ConfigError);
  });

  it("names a missing GitHub App id rather than crashing", () => {
    const { [APP_ID_ENV]: _omit, ...envWithoutAppId } = ENV;

    expect(() =>
      resolveDaemonConfig({}, envWithoutAppId, "/home/operator"),
    ).toThrow(ConfigError);
  });

  it("names a missing GitHub App private key rather than crashing", () => {
    const { [APP_PRIVATE_KEY_ENV]: _omit, ...envWithoutKey } = ENV;

    expect(() =>
      resolveDaemonConfig({}, envWithoutKey, "/home/operator"),
    ).toThrow(ConfigError);
  });

  it("names a missing Claude Code OAuth token rather than crashing", () => {
    const { [CLAUDE_CODE_OAUTH_TOKEN_ENV]: _omit, ...envWithoutToken } = ENV;

    expect(() =>
      resolveDaemonConfig({}, envWithoutToken, "/home/operator"),
    ).toThrow(ConfigError);
  });
});
