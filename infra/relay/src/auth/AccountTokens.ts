// Trevize: relay clients sign in with a Trevize account (Better Auth) instead of
// Clerk. Better Auth's `jwt` plugin issues short-lived account JWTs, and the relay
// verifies them against its JWKS. Upstream's Clerk verification in http/Api.ts
// stays in place and runs only when `accountAuth` is not configured.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AccountTokenSettings {
  /** Better Auth base URL, matched against the token's `iss`. */
  readonly issuer: string;
  /** Expected `aud`. Better Auth defaults this to its base URL. */
  readonly audience: string;
  /** Better Auth JWKS endpoint, normally `<issuer>/api/auth/jwks`. */
  readonly jwksUrl: string;
}

// One key set per isolate; jose caches keys and refetches on unknown `kid`.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(jwksUrl: string) {
  let keys = keySets.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl));
    keySets.set(jwksUrl, keys);
  }
  return keys;
}

/** Verifies a Better Auth account JWT. Resolves to its claims or rejects. */
export async function verifyAccountToken(
  settings: AccountTokenSettings,
  token: string,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, keySet(settings.jwksUrl), {
    issuer: settings.issuer,
    audience: settings.audience,
  });
  return payload;
}

export function accountAuthSettings(issuerUrl: string): AccountTokenSettings {
  const issuer = issuerUrl.replace(/\/+$/, "");
  return { issuer, audience: issuer, jwksUrl: `${issuer}/api/auth/jwks` };
}
