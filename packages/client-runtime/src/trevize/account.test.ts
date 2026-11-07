import { describe, expect, it } from "@effect/vitest";

import { createTrevizeAccount, type TrevizeRelayTokenLookup } from "./account.ts";

const relayJwt = (sub: string) =>
  [btoa(JSON.stringify({ alg: "EdDSA" })), btoa(JSON.stringify({ sub })), "signature"].join(".");

function setup(lookups: Array<TrevizeRelayTokenLookup>) {
  const account = createTrevizeAccount(async () => lookups.shift() ?? { _tag: "Unknown" });
  const users: Array<string | null> = [];
  account.addListener((resources) => {
    users.push(resources.user?.id ?? null);
  });
  return { account, users };
}

describe("createTrevizeAccount", () => {
  it("reports the account the relay token belongs to", async () => {
    const { account, users } = setup([{ _tag: "Known", token: relayJwt("user_1") }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(users).toEqual(["user_1"]);
    expect(account.getSnapshot()).toEqual({ isLoaded: true, userId: "user_1" });
  });

  it("does not report a sign-out when Trevize is unreachable", async () => {
    const { account, users } = setup([{ _tag: "Unknown" }]);
    expect(await account.readRelayToken()).toBeNull();
    expect(users).toEqual([]);
    expect(account.getSnapshot()).toEqual({ isLoaded: true, userId: null });
  });

  it("signs out when the session has ended", async () => {
    const { account, users } = setup([
      { _tag: "Known", token: relayJwt("user_1") },
      { _tag: "Known", token: null },
    ]);
    await account.readRelayToken();
    expect(await account.readRelayToken()).toBeNull();
    expect(users.at(-1)).toBeNull();
    expect(account.getSnapshot().userId).toBeNull();
  });
});
