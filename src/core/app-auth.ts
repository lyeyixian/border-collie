/**
 * GitHub App authentication (issue #178): the pure half. Claim construction
 * for the JWT a Worker-less process signs to authenticate as the App itself,
 * and the env-scrubbing rule that keeps the App private key out of a
 * spawned Worker's process — both pure functions over plain inputs, no I/O.
 * The signing, minting, and listing that use these live in
 * adapters/app-auth.ts.
 */

/** Named rather than a bare Error, so a missing or malformed key is a diagnosable failure, not a crash (issue #178). */
export class AppAuthError extends Error {}

/** Env var name the operator sets the GitHub App's private key in. Never forwarded to a Worker process — see `stripAppPrivateKey`. */
export const APP_PRIVATE_KEY_ENV = "BORDER_COLLIE_APP_PRIVATE_KEY";

/** GitHub allows up to 60s of clock drift behind its own clock. */
const CLOCK_DRIFT_LEEWAY_SECONDS = 60;

/** GitHub refuses an App JWT whose lifetime exceeds ten minutes. */
const MAX_JWT_LIFETIME_SECONDS = 600;

export interface AppJwtClaims {
  /** The App's own id — who is asserting this JWT. */
  iss: string;
  iat: number;
  exp: number;
}

/**
 * The GitHub App JWT's claim set (issue #178 acceptance criteria: "pure
 * function over the App identity and the current time"). `iat` is backdated
 * by the drift leeway and `exp` set to the maximum lifetime GitHub accepts,
 * so a freshly minted JWT is valid immediately and for as long as GitHub
 * will honour one.
 */
export function buildAppJwtClaims(appId: string, nowMs: number): AppJwtClaims {
  const nowSeconds = Math.floor(nowMs / 1000);
  return {
    iss: appId,
    iat: nowSeconds - CLOCK_DRIFT_LEEWAY_SECONDS,
    exp: nowSeconds + MAX_JWT_LIFETIME_SECONDS,
  };
}

/**
 * Strips the App private key from an environment about to be handed to a
 * spawned process (issue #178: "never written into a Worker's
 * environment"), leaving every other variable untouched. A Worker session
 * runs an agent with shell and file access, so inheriting the key the way a
 * spawned process inherits everything else in `process.env` would hand it
 * the means to mint its own tokens.
 */
export function stripAppPrivateKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [APP_PRIVATE_KEY_ENV]: _privateKey, ...rest } = env;
  return rest;
}
