import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionProfile } from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import * as TrevizeApi from "./api.ts";
import { connectTrevizeEnvironment, findSavedTrevizeEnvironment } from "./connect.ts";

const config: TrevizeApi.TrevizeApiConfig = {
  baseUrl: "https://trevize.example.test/",
  apiKey: " tvz_test ",
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string | null;
  readonly headerNames: ReadonlyArray<string>;
}

function layerTrevizeHttp(calls: Array<Call>, responses: Array<() => Response>) {
  return layerRemoteHttpClient((input, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? "GET",
      url: String(input),
      authorization: headers.get("authorization"),
      headerNames: [...headers.keys()],
      body:
        init.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : init.body == null
            ? null
            : String(init.body),
    });
    const next = responses.shift();
    return next === undefined
      ? Promise.reject(new Error(`Unexpected request: ${String(input)}`))
      : Promise.resolve(next());
  });
}

const environmentJson = {
  id: "env_1",
  workspaceId: "ws_1",
  title: "Checkout revamp",
  status: "running",
  repositoryIds: ["acme/web"],
  httpBaseUrl: "https://t3-env_1.gw.example.test",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastActivityAt: null,
  error: null,
};

const readyJson = {
  status: "ready",
  httpBaseUrl: "https://t3-env_1.gw.example.test",
  wsBaseUrl: "wss://t3-env_1.gw.example.test",
  pairingToken: "pairing-token",
  pairingUrl: "https://app.t3.codes/pair?host=x#token=pairing-token",
  expiresAt: "2026-10-01T00:10:00.000Z",
  label: "Checkout revamp",
};

describe("Trevize API client", () => {
  it.effect("sends the API key as a bearer token, no trace headers, and decodes environments", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const environments = yield* TrevizeApi.listEnvironments(config, "ws 1").pipe(
        Effect.provide(
          layerTrevizeHttp(calls, [
            () => Response.json({ environments: [environmentJson], extra: true }),
          ]),
        ),
      );

      expect(environments).toEqual([environmentJson]);
      expect(calls).toEqual([
        {
          method: "GET",
          url: "https://trevize.example.test/api/v1/t3/environments?workspaceId=ws+1",
          authorization: "Bearer tvz_test",
          body: null,
          // No `traceparent`/`b3`: Trevize's CORS preflight rejects them.
          headerNames: ["accept", "authorization"],
        },
      ]);
    }),
  );

  it.effect("posts the create body and omits an empty title", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      yield* TrevizeApi.createEnvironment(config, {
        workspaceId: "ws_1",
        repositoryIds: ["acme/web"],
        title: "  ",
      }).pipe(
        Effect.provide(
          layerTrevizeHttp(calls, [() => Response.json({ ...environmentJson, title: null })]),
        ),
      );

      expect(calls[0]?.method).toBe("POST");
      expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
        workspaceId: "ws_1",
        repositoryIds: ["acme/web"],
      });
    }),
  );

  it.effect("maps an auth rejection to an unauthorized error with the server message", () =>
    Effect.gen(function* () {
      const error = yield* TrevizeApi.listWorkspaces(config).pipe(
        Effect.flip,
        Effect.provide(
          layerTrevizeHttp(
            [],
            [
              () =>
                Response.json(
                  {
                    error: {
                      code: "invalid_api_key",
                      message: "Invalid API key.",
                    },
                  },
                  { status: 401 },
                ),
            ],
          ),
        ),
      );

      expect(error).toMatchObject({
        _tag: "TrevizeApiError",
        reason: "unauthorized",
        status: 401,
        message: "Invalid API key.",
      });
    }),
  );

  it.effect("rejects a response that does not match the contract", () =>
    Effect.gen(function* () {
      const error = yield* TrevizeApi.listEnvironments(config, "ws_1").pipe(
        Effect.flip,
        Effect.provide(
          layerTrevizeHttp(
            [],
            [
              () =>
                Response.json({
                  environments: [{ ...environmentJson, status: "melting" }],
                }),
            ],
          ),
        ),
      );

      expect(error.reason).toBe("decode");
    }),
  );

  it.effect("polls connect while the environment is starting", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fiber = yield* TrevizeApi.connectWhenReady(config, "env_1").pipe(
        Effect.provide(
          layerTrevizeHttp(calls, [
            () => Response.json({ status: "starting", retryAfterSeconds: 5 }),
            () => Response.json({ status: "starting", retryAfterSeconds: 0 }),
            () => Response.json(readyJson),
          ]),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      // A zero retry hint is clamped to one second rather than spinning.
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);

      expect(result.pairingToken).toBe("pairing-token");
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(
        Array.from(
          { length: 3 },
          () => "POST https://trevize.example.test/api/v1/t3/environments/env_1/connect",
        ),
      );
    }),
  );

  it.effect("gives up once the bounded wait would be exceeded", () =>
    Effect.gen(function* () {
      const fiber = yield* TrevizeApi.connectWhenReady(config, "env_1", {
        maxWaitMs: 12_000,
      }).pipe(
        Effect.flip,
        Effect.provide(
          layerTrevizeHttp(
            [],
            Array.from(
              { length: 3 },
              () => () => Response.json({ status: "starting", retryAfterSeconds: 10 }),
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);

      expect(error.reason).toBe("timeout");
    }),
  );

  it.effect("stops with the server's error when the environment failed to start", () =>
    Effect.gen(function* () {
      const error = yield* TrevizeApi.connectWhenReady(config, "env_1").pipe(
        Effect.flip,
        Effect.provide(
          layerTrevizeHttp(
            [],
            [
              () =>
                Response.json({
                  status: "failed",
                  error: "Repository not found",
                  retryAfterSeconds: 42,
                }),
            ],
          ),
        ),
      );

      expect(error.reason).toBe("failed");
      expect(error.message).toContain("Repository not found");
    }),
  );
});

describe("wakeWhenReady", () => {
  const wakeUrl = "POST https://trevize.example.test/api/v1/t3/environments/env_1/wake";
  const connectUrl = "POST https://trevize.example.test/api/v1/t3/environments/env_1/connect";

  it.effect("polls wake until the environment runs, without minting a pairing token", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const fiber = yield* TrevizeApi.wakeWhenReady(config, "env_1").pipe(
        Effect.provide(
          layerTrevizeHttp(calls, [
            () => Response.json({ status: "starting", retryAfterSeconds: 3 }),
            () => Response.json({ status: "provisioning" }),
            () => Response.json({ status: "running" }),
          ]),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("3 seconds");
      // An unknown status without a retry hint waits the default two seconds.
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        wakeUrl,
        wakeUrl,
        wakeUrl,
      ]);
    }),
  );

  it.effect("stops with the server's error when the environment failed to start", () =>
    Effect.gen(function* () {
      const error = yield* TrevizeApi.wakeWhenReady(config, "env_1").pipe(
        Effect.flip,
        Effect.provide(
          layerTrevizeHttp(
            [],
            [() => Response.json({ status: "failed", error: "Out of capacity" })],
          ),
        ),
      );

      expect(error.reason).toBe("failed");
      expect(error.message).toContain("Out of capacity");
    }),
  );

  it.effect("falls back to connect on a Trevize without wake", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      yield* TrevizeApi.wakeWhenReady(config, "env_1").pipe(
        Effect.provide(
          layerTrevizeHttp(calls, [
            () => Response.json({ message: "Not found" }, { status: 404 }),
            () => Response.json(readyJson),
          ]),
        ),
      );

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([wakeUrl, connectUrl]);
    }),
  );
});

describe("connectTrevizeEnvironment", () => {
  it.effect("redeems the pairing token through the pairing flow with the Trevize title", () =>
    Effect.gen(function* () {
      const pairings: Array<ConnectionOnboarding.PairingConnectionInput> = [];
      const onboarding = Layer.succeed(
        ConnectionOnboarding.ConnectionOnboarding,
        ConnectionOnboarding.ConnectionOnboarding.of({
          registerPairing: (input) =>
            Effect.sync(() => {
              pairings.push(input);
              return EnvironmentId.make("t3-environment");
            }),
          registerSsh: () => Effect.die("unused"),
          updateBearer: () => Effect.die("unused"),
        }),
      );

      const environmentId = yield* connectTrevizeEnvironment({
        config,
        environment: { id: "env_1", title: "Checkout revamp" },
      }).pipe(
        Effect.provide(
          Layer.merge(onboarding, layerTrevizeHttp([], [() => Response.json(readyJson)])),
        ),
      );

      expect(environmentId).toBe("t3-environment");
      expect(pairings).toEqual([
        {
          host: "https://t3-env_1.gw.example.test",
          pairingCode: "pairing-token",
          label: "Checkout revamp",
          // Only the gateway reaches the sandbox, never its container addresses.
          learnRoutes: false,
        },
      ]);
    }),
  );
});

describe("findSavedTrevizeEnvironment", () => {
  const environmentId = EnvironmentId.make("t3-environment");
  const bearerEntry = {
    target: new RelayConnectionTarget({
      environmentId,
      label: "Checkout revamp",
    }),
    profile: Option.none(),
    alternateRoutes: [
      {
        target: new BearerConnectionTarget({
          environmentId,
          label: "Checkout revamp",
          connectionId: "bearer:t3-environment:https://t3-env_1.gw.example.test",
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "bearer:t3-environment:https://t3-env_1.gw.example.test",
            environmentId,
            label: "Checkout revamp",
            httpBaseUrl: "https://t3-env_1.gw.example.test/",
            wsBaseUrl: "wss://t3-env_1.gw.example.test/",
          }),
        ),
      },
    ],
    enabled: true,
  };

  it("matches a saved route by gateway origin", () => {
    expect(findSavedTrevizeEnvironment([bearerEntry], "https://t3-env_1.gw.example.test")).toBe(
      environmentId,
    );
    expect(findSavedTrevizeEnvironment([bearerEntry], "https://t3-env_2.gw.example.test")).toBe(
      null,
    );
  });
});
