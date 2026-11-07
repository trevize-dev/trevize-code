import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "@effect/vitest";

import { accountAuthSettings, verifyAccountToken } from "./AccountTokens.ts";

const settings = accountAuthSettings("https://auth.trevize.test/");

const trusted = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const untrusted = await generateKeyPair("EdDSA", { crv: "Ed25519" });

const sign = (
  key: CryptoKey,
  claims: { readonly iss?: string; readonly aud?: string; readonly exp?: string } = {},
) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "trusted" })
    .setSubject("user_123")
    .setIssuer(claims.iss ?? settings.issuer)
    .setAudience(claims.aud ?? settings.audience)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "15m")
    .sign(key);

describe("verifyAccountToken", () => {
  beforeAll(async () => {
    const jwk = { ...(await exportJWK(trusted.publicKey)), kid: "trusted", alg: "EdDSA" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input instanceof Request ? input.url : input)).toBe(settings.jwksUrl);
        return Response.json({ keys: [jwk] });
      }),
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("derives the JWKS endpoint from the Better Auth URL", () => {
    expect(settings).toEqual({
      issuer: "https://auth.trevize.test",
      audience: "https://auth.trevize.test",
      jwksUrl: "https://auth.trevize.test/api/auth/jwks",
    });
  });

  it("accepts a Better Auth account token", async () => {
    const claims = await verifyAccountToken(settings, await sign(trusted.privateKey));
    expect(claims.sub).toBe("user_123");
  });

  it("rejects a token signed by another key", async () => {
    await expect(verifyAccountToken(settings, await sign(untrusted.privateKey))).rejects.toThrow();
  });

  it("rejects a token for another audience", async () => {
    const token = await sign(trusted.privateKey, { aud: "https://elsewhere.test" });
    await expect(verifyAccountToken(settings, token)).rejects.toThrow();
  });

  it("rejects a token from another issuer", async () => {
    const token = await sign(trusted.privateKey, { iss: "https://elsewhere.test" });
    await expect(verifyAccountToken(settings, token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await sign(trusted.privateKey, { exp: "-1m" });
    await expect(verifyAccountToken(settings, token)).rejects.toThrow();
  });
});
