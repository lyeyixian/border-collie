import { describe, expect, it } from "vitest";
import {
  APP_PRIVATE_KEY_ENV,
  buildAppJwtClaims,
  stripAppPrivateKey,
} from "../../src/core/app-auth.js";

describe("buildAppJwtClaims", () => {
  it("issues the App's id and a ten-minute window backdated for clock drift", () => {
    const now = Date.parse("2026-08-25T12:00:00Z");
    expect(buildAppJwtClaims("123456", now)).toEqual({
      iss: "123456",
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 600,
    });
  });

  it("is pure over the App identity and the current time: same inputs, same claims", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(buildAppJwtClaims("1", now)).toEqual(buildAppJwtClaims("1", now));
  });

  it("shifts iat and exp with now, keeping the same ten-minute span", () => {
    const first = buildAppJwtClaims("1", Date.parse("2026-01-01T00:00:00Z"));
    const second = buildAppJwtClaims("1", Date.parse("2026-01-01T00:05:00Z"));
    expect(second.iat - first.iat).toBe(300);
    expect(second.exp - first.exp).toBe(300);
  });

  it("carries a different App's id straight through as iss", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(buildAppJwtClaims("999999", now).iss).toBe("999999");
  });
});

describe("stripAppPrivateKey", () => {
  it("removes the private key from an environment, leaving every other variable untouched", () => {
    const env = {
      PATH: "/usr/bin",
      [APP_PRIVATE_KEY_ENV]: "-----BEGIN PRIVATE KEY-----\n...",
      GH_TOKEN: "ghs_abc",
    };
    expect(stripAppPrivateKey(env)).toEqual({
      PATH: "/usr/bin",
      GH_TOKEN: "ghs_abc",
    });
  });

  it("is a no-op when the key was never set", () => {
    const env = { PATH: "/usr/bin" };
    expect(stripAppPrivateKey(env)).toEqual(env);
  });
});
