import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { layerRemoteHttpClient } from "../rpc/http.ts";
import {
  awaitTrevizeDeviceSignIn,
  revokeTrevizeSession,
  startTrevizeDeviceSignIn,
  type TrevizeDeviceSignIn,
} from "./deviceAuth.ts";

interface Call {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function layerHttp(calls: Array<Call>, responses: Array<() => Response>) {
  return layerRemoteHttpClient((input, init = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      body: body === null ? null : JSON.parse(body),
    });
    const next = responses.shift();
    return next === undefined
      ? Promise.reject(new Error(`Unexpected request: ${String(input)}`))
      : Promise.resolve(next());
  });
}

const pending: TrevizeDeviceSignIn = {
  baseUrl: "https://trevize.example.test",
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://trevize.example.test/device?user_code=ABCD-EFGH",
  intervalSeconds: 5,
  expiresAtMs: 30 * 60_000,
};

const oauthError = (error: string) => () => Response.json({ error }, { status: 400 });

describe("Trevize device sign-in", () => {
  it.effect("requests a code as the trevize-code client", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const signIn = yield* startTrevizeDeviceSignIn("trevize.example.test/").pipe(
        Effect.provide(
          layerHttp(calls, [
            () =>
              Response.json({
                device_code: "device-code",
                user_code: "ABCD-EFGH",
                verification_uri: "https://trevize.example.test/device",
                verification_uri_complete:
                  "https://trevize.example.test/device?user_code=ABCD-EFGH",
                expires_in: 1800,
                interval: 5,
              }),
          ]),
        ),
      );

      expect(calls).toEqual([
        {
          url: "https://trevize.example.test/api/auth/device/code",
          authorization: null,
          body: { client_id: "trevize-code", scope: "profile api" },
        },
      ]);
      expect(signIn).toEqual({ ...pending, expiresAtMs: 1800_000 });
    }),
  );

  it.effect("tells the user when the Trevize does not know this client", () =>
    Effect.gen(function* () {
      const error = yield* startTrevizeDeviceSignIn("https://trevize.example.test").pipe(
        Effect.flip,
        Effect.provide(layerHttp([], [oauthError("invalid_client")])),
      );
      expect(error.message).toContain("Use an API key");
    }),
  );

  it.effect("polls through pending and slow_down until it gets a token", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fiber = yield* awaitTrevizeDeviceSignIn(pending).pipe(
        Effect.provide(
          layerHttp(calls, [
            oauthError("authorization_pending"),
            oauthError("slow_down"),
            () => Response.json({ access_token: "session-token", token_type: "Bearer" }),
          ]),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      // `slow_down` adds five seconds to the interval.
      yield* TestClock.adjust("10 seconds");
      const token = yield* Fiber.join(fiber);

      expect(token).toBe("session-token");
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual({
        url: "https://trevize.example.test/api/auth/device/token",
        authorization: null,
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-code",
          client_id: "trevize-code",
        },
      });
    }),
  );

  it.effect("stops when the user denies the code", () =>
    Effect.gen(function* () {
      const fiber = yield* awaitTrevizeDeviceSignIn(pending).pipe(
        Effect.flip,
        Effect.provide(layerHttp([], [oauthError("access_denied")])),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.reason).toBe("unauthorized");
    }),
  );

  it.effect("stops without polling once the code has expired", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fiber = yield* awaitTrevizeDeviceSignIn({ ...pending, expiresAtMs: 1000 }).pipe(
        Effect.flip,
        Effect.provide(layerHttp(calls, [])),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.reason).toBe("timeout");
      expect(calls).toEqual([]);
    }),
  );
});

describe("revokeTrevizeSession", () => {
  it.effect("signs a device session out", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      yield* revokeTrevizeSession("https://trevize.example.test", "session-token").pipe(
        Effect.provide(layerHttp(calls, [() => Response.json({ success: true })])),
      );
      expect(calls.map((call) => [call.url, call.authorization])).toEqual([
        ["https://trevize.example.test/api/auth/sign-out", "Bearer session-token"],
      ]);
    }),
  );

  it.effect("leaves API keys alone and ignores failures", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      yield* revokeTrevizeSession("https://trevize.example.test", "tvz_key").pipe(
        Effect.provide(layerHttp(calls, [])),
      );
      expect(calls).toEqual([]);
      // No response queued: the request fails, and sign-out still succeeds.
      yield* revokeTrevizeSession("https://trevize.example.test", "session-token").pipe(
        Effect.provide(layerHttp([], [])),
      );
    }),
  );
});
