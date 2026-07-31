import { describe, expect, it } from "vitest";
import { scrubCredentials } from "../../src/core/log.js";

describe("scrubCredentials", () => {
  it("leaves ordinary text untouched", () => {
    const text = "gh issue view 5 (exit 0)";

    expect(scrubCredentials(text)).toBe(text);
  });

  it("leaves a plain https remote untouched", () => {
    const text = "git fetch https://github.com/lyeyixian/border-collie.git";

    expect(scrubCredentials(text)).toBe(text);
  });

  it("leaves an SSH remote untouched (no credential, `git` is a fixed username)", () => {
    const text = "git push git@github.com:lyeyixian/border-collie.git";

    expect(scrubCredentials(text)).toBe(text);
  });

  it("redacts a classic GitHub PAT", () => {
    const token = `ghp_${"A".repeat(36)}`;

    expect(scrubCredentials(`token: ${token}`)).toBe("token: <redacted>");
  });

  it("redacts a fine-grained GitHub PAT", () => {
    const token = `github_pat_${"A".repeat(30)}`;

    expect(scrubCredentials(`token: ${token}`)).toBe("token: <redacted>");
  });

  it("redacts a token embedded as a URL's userinfo segment", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const url = `https://x-access-token:${token}@github.com/lyeyixian/border-collie.git`;

    expect(scrubCredentials(url)).toBe(
      "https://<redacted>@github.com/lyeyixian/border-collie.git",
    );
  });

  it("redacts a bare token embedded as a URL's userinfo segment, no username", () => {
    const token = `ghp_${"A".repeat(36)}`;

    expect(scrubCredentials(`https://${token}@github.com/o/r.git`)).toBe(
      "https://<redacted>@github.com/o/r.git",
    );
  });

  it("redacts a Bearer authorization header", () => {
    expect(scrubCredentials("Authorization: Bearer abc123.def-456_ghi")).toBe(
      "Authorization: Bearer <redacted>",
    );
  });
});
