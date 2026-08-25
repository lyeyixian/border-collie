import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  execWithToken,
  listFleetRepositories,
  mintRepositoryToken,
  signAppJwt,
} from "../../src/adapters/app-auth.js";
import { claimTicket, readTicketTitle } from "../../src/adapters/tracker.js";
import { AppAuthError } from "../../src/core/app-auth.js";

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("signAppJwt", () => {
  let privateKey: string;
  let publicKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  it("signs a JWT carrying the claim set and a signature GitHub's own RS256 verification would accept", () => {
    const now = Date.parse("2026-08-25T12:00:00Z");
    const jwt = signAppJwt("123456", privateKey, now);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [headerSeg = "", payloadSeg = "", signatureSeg = ""] = parts;
    expect(decodeSegment(headerSeg)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(payloadSeg)).toEqual({
      iss: "123456",
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 600,
    });

    const signature = Buffer.from(
      signatureSeg.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${payloadSeg}`);
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it("names a missing private key rather than crashing", () => {
    expect(() => signAppJwt("123456", undefined, Date.now())).toThrow(
      AppAuthError,
    );
    expect(() => signAppJwt("123456", "", Date.now())).toThrow(AppAuthError);
  });

  it("names a malformed private key rather than crashing", () => {
    expect(() => signAppJwt("123456", "not a key", Date.now())).toThrow(
      AppAuthError,
    );
  });
});

describe("mintRepositoryToken", () => {
  let privateKey: string;

  beforeAll(() => {
    privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
  });

  it("mints a token that names exactly the one repository it was requested for", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/repos/acme/widget/installation")) {
        return new Response(JSON.stringify({ id: 42 }), { status: 200 });
      }
      if (String(url).endsWith("/app/installations/42/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_scoped",
            expires_at: "2026-08-25T13:00:00Z",
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    const result = await mintRepositoryToken(
      { appId: "123456", privateKey },
      { owner: "acme", name: "widget" },
      Date.parse("2026-08-25T12:00:00Z"),
      fetchImpl,
    );

    expect(result).toEqual({
      token: "ghs_scoped",
      expiresAt: "2026-08-25T13:00:00Z",
    });
    const mintCall = calls.find((call) => call.url.includes("access_tokens"));
    expect(JSON.parse(mintCall?.init.body as string)).toEqual({
      repositories: ["widget"],
    });
  });

  it("surfaces GitHub refusing to mint a token for a repository the App is not installed on as a named error, rather than a token that silently reaches it", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/installation")) {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      mintRepositoryToken(
        { appId: "123456", privateKey },
        { owner: "acme", name: "other" },
        Date.now(),
        fetchImpl,
      ),
    ).rejects.toThrow(AppAuthError);
  });
});

describe("listFleetRepositories", () => {
  it("lists every repository across every installation, not a list border-collie stores itself", async () => {
    const privateKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/app/installations?")) {
        return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
          status: 200,
        });
      }
      const mintMatch = target.match(
        /\/app\/installations\/(\d+)\/access_tokens$/,
      );
      if (mintMatch) {
        return new Response(
          JSON.stringify({
            token: `ghs_${mintMatch[1]}`,
            expires_at: "2026-08-25T13:00:00Z",
          }),
          { status: 201 },
        );
      }
      if (target.includes("/installation/repositories")) {
        const headers = init?.headers as Record<string, string>;
        const repos =
          headers.Authorization === "Bearer ghs_1"
            ? [{ name: "widget", owner: { login: "acme" } }]
            : [{ name: "gizmo", owner: { login: "acme" } }];
        return new Response(JSON.stringify({ repositories: repos }), {
          status: 200,
        });
      }
      throw new Error(`unexpected request: ${target}`);
    }) as unknown as typeof fetch;

    const repositories = await listFleetRepositories(
      { appId: "123456", privateKey },
      Date.now(),
      fetchImpl,
    );

    expect(repositories).toEqual([
      { owner: "acme", name: "widget" },
      { owner: "acme", name: "gizmo" },
    ]);
  });
});

describe("execWithToken", () => {
  it("authenticates gh via GH_TOKEN without mutating the ambient environment", async () => {
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = execWithToken("ghs_scoped", async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return "ok";
    });
    const before = { ...process.env };

    await expect(exec("gh", ["issue", "view", "42"])).resolves.toBe("ok");

    expect(calls[0]?.env.GH_TOKEN).toBe("ghs_scoped");
    expect(process.env).toEqual(before);
  });

  it("drives a real tracker read and a real tracker write successfully", async () => {
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec = execWithToken("ghs_scoped", async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      if (args[0] === "api") return JSON.stringify({ title: "Do the thing" });
      return "";
    });

    await expect(readTicketTitle(178, exec)).resolves.toBe("Do the thing");
    await claimTicket(178, exec);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.env.GH_TOKEN === "ghs_scoped")).toBe(
      true,
    );
  });
});
