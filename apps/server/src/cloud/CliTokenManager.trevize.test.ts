import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

// Trevize: with no Clerk key configured, the CLI signs in with the Trevize
// device flow and sends the relay a JWT minted from the Trevize session.
const TREVIZE_ENV = { T3CODE_TREVIZE_URL: "https://trevize.example.test" };

const provideTrevizeEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: TREVIZE_ENV })),
);

const EXPIRES_AT_SECONDS = 2_000_000_000;
const relayJwt = (id: string) =>
  [
    btoa(JSON.stringify({ alg: "EdDSA" })),
    btoa(JSON.stringify({ sub: "user_123", exp: EXPIRES_AT_SECONDS, jti: id })).replace(/=+$/, ""),
    "signature",
  ].join(".");

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly params: URLSearchParams;
}

type Reply = { readonly status: number; readonly body: unknown };

const layerTrevize = (requests: Array<RecordedRequest>, replies: Record<string, Array<Reply>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        // Better Auth rejects form bodies with 415, so the CLI must send JSON.
        const json: unknown = body === "" ? {} : JSON.parse(body);
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          params: new URLSearchParams(json as Record<string, string>),
        });
        const path = new URL(request.url).pathname;
        const queue = replies[path] ?? [];
        const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {
          status: 404,
          body: {},
        };
        return HttpClientResponse.fromWeb(
          request,
          Response.json(reply.body, { status: reply.status }),
        );
      }),
    ),
  );

const deviceCode = {
  status: 200,
  body: {
    device_code: "device-code-1",
    user_code: "BCDF-GHJK",
    verification_uri: "https://trevize.example.test/device",
    verification_uri_complete: "https://trevize.example.test/device?user_code=BCDF-GHJK",
    expires_in: 1800,
    interval: 5,
  },
};
const sessionGranted = {
  status: 200,
  body: {
    access_token: "session-1",
    token_type: "Bearer",
    expires_in: 604800,
    scope: "profile api",
  },
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "CliTokenManager with Trevize sign-in",
  (it) => {
    it.effect("signs in with the Trevize device flow and stores a relay token", () =>
      Effect.gen(function* () {
        const requests: Array<RecordedRequest> = [];
        const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
          Effect.provide(
            layerTrevize(requests, {
              "/api/auth/device/code": [deviceCode],
              "/api/auth/device/token": [
                { status: 400, body: { error: "authorization_pending" } },
                sessionGranted,
              ],
              "/api/auth/token": [{ status: 200, body: { token: relayJwt("first") } }],
            }),
          ),
          provideTrevizeEnv,
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(10));
        const { token } = yield* Fiber.join(fiber);

        assert.equal(token.accessToken, relayJwt("first"));
        assert.equal(token.refreshToken, "session-1");
        assert.equal(token.expiresAtEpochMs, EXPIRES_AT_SECONDS * 1_000);

        const authorization = requests[0]!;
        assert.equal(authorization.url, "https://trevize.example.test/api/auth/device/code");
        assert.equal(authorization.params.get("client_id"), "trevize-code");
        assert.equal(authorization.params.get("scope"), "profile api");

        const mint = requests.at(-1)!;
        assert.equal(mint.method, "GET");
        assert.equal(mint.url, "https://trevize.example.test/api/auth/token");
        assert.equal(mint.authorization, "Bearer session-1");
      }),
    );
  },
);

const expiredStoredToken = new TextEncoder().encode(
  JSON.stringify({ accessToken: "expired", refreshToken: "session-1", expiresAtEpochMs: 0 }),
);

const provideManager = (requests: Array<RecordedRequest>, replies: Record<string, Array<Reply>>) =>
  Effect.provide(
    CliTokenManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerTrevize(requests, replies),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeedSome(expiredStoredToken),
            set: () => Effect.void,
          }),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: TREVIZE_ENV }))),
    ),
  );

it.effect("refreshes by minting a new relay token from the Trevize session", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedRequest> = [];
    const token = yield* Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      return yield* manager.getExisting;
    }).pipe(
      provideManager(requests, {
        "/api/auth/token": [{ status: 200, body: { token: relayJwt("refreshed") } }],
      }),
    );

    assert.isTrue(Option.isSome(token));
    if (Option.isSome(token)) {
      assert.equal(token.value.accessToken, relayJwt("refreshed"));
      assert.equal(token.value.refreshToken, "session-1");
    }
    assert.deepEqual(
      requests.map((request) => [request.url, request.authorization]),
      [["https://trevize.example.test/api/auth/token", "Bearer session-1"]],
    );
  }),
);

it.effect("asks to sign in again when the Trevize session has ended", () =>
  Effect.gen(function* () {
    const error = yield* Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      return yield* manager.getExisting;
    }).pipe(provideManager([], { "/api/auth/token": [{ status: 401, body: {} }] }), Effect.flip);

    assert.isTrue(CliTokenManager.isCloudCliCredentialRefreshError(error));
    if (CliTokenManager.isCloudCliCredentialRefreshError(error)) {
      assert.isTrue(error.requiresLogin);
    }
  }),
);
