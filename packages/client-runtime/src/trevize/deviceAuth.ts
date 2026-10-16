import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import { normalizeTrevizeBaseUrl, TrevizeApiError } from "./api.ts";

/**
 * Sign-in to Trevize with the OAuth 2.0 Device Authorization Grant (RFC 8628),
 * the flow the Trevize CLI uses. The client shows a short code, the user
 * approves it on Trevize's `/device` page in any browser, and the client
 * polls for a session token. It needs no redirect URI, so it works the same
 * from app.t3.codes, `t3 serve` on any LAN or tailnet origin, desktop and
 * mobile. The token is a bearer credential for `/api/v1`, like an API key.
 */

/** Trevize's trusted public client id for this app. */
export const TREVIZE_CODE_CLIENT_ID = "trevize-code";
const DEVICE_SCOPE = "profile api";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 §3.5: back off by 5 seconds on every `slow_down`. */
const SLOW_DOWN_SECONDS = 5;

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.Number,
});

const DeviceTokenResponse = Schema.Struct({ access_token: Schema.String });

const DeviceErrorBody = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

/** A pending sign-in: show `userCode` and open `verificationUrl`, then await it. */
export interface TrevizeDeviceSignIn {
  readonly baseUrl: string;
  readonly deviceCode: string;
  readonly userCode: string;
  /** Trevize's approval page with the code filled in. */
  readonly verificationUrl: string;
  readonly intervalSeconds: number;
  readonly expiresAtMs: number;
}

/** The client opens this URL, so only an http(s) page is accepted. */
function webUrlOr(value: string, fallback: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function authUrl(baseUrl: string, path: string): string {
  return `${normalizeTrevizeBaseUrl(baseUrl)}/api/auth${path}`;
}

const postJson = (url: string, body: object) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(
          (cause) =>
            new TrevizeApiError({
              reason: "network",
              message: `Could not reach Trevize: ${cause.message}`,
            }),
        ),
      );
  });

const decode =
  <S extends Schema.Constraint>(schema: S, status: number) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new TrevizeApiError({
            reason: "decode",
            status,
            message: `Unexpected response from Trevize: ${cause.message}`,
          }),
      ),
    );

/** Asks Trevize for a device code to approve. */
export const startTrevizeDeviceSignIn = Effect.fn("clientRuntime.trevize.startDeviceSignIn")(
  function* (baseUrl: string) {
    const response = yield* postJson(authUrl(baseUrl, "/device/code"), {
      client_id: TREVIZE_CODE_CLIENT_ID,
      scope: DEVICE_SCOPE,
    });
    const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status !== 200) {
      const error = yield* decode(
        DeviceErrorBody,
        response.status,
      )(json).pipe(Effect.orElseSucceed(() => null));
      return yield* new TrevizeApiError({
        reason: "request",
        status: response.status,
        message:
          error?.error === "invalid_client"
            ? "This Trevize does not support signing in from Trevize Code yet. Use an API key."
            : (error?.error_description ?? `Trevize answered with HTTP ${response.status}.`),
      });
    }
    const body = yield* decode(DeviceCodeResponse, response.status)(json);
    const now = yield* Clock.currentTimeMillis;
    const origin = normalizeTrevizeBaseUrl(baseUrl);
    return {
      baseUrl: origin,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUrl: webUrlOr(
        body.verification_uri_complete ?? body.verification_uri,
        `${origin}/device?user_code=${encodeURIComponent(body.user_code)}`,
      ),
      intervalSeconds: Math.max(1, body.interval),
      expiresAtMs: now + body.expires_in * 1000,
    } satisfies TrevizeDeviceSignIn;
  },
);

/** Polls until the user approves the code, and returns the session token. */
export const awaitTrevizeDeviceSignIn = Effect.fn("clientRuntime.trevize.awaitDeviceSignIn")(
  function* (signIn: TrevizeDeviceSignIn) {
    let intervalSeconds = signIn.intervalSeconds;
    while (true) {
      yield* Effect.sleep(Duration.seconds(intervalSeconds));
      if ((yield* Clock.currentTimeMillis) >= signIn.expiresAtMs) {
        return yield* new TrevizeApiError({
          reason: "timeout",
          message: "The sign-in code expired. Start again.",
        });
      }
      const response = yield* postJson(authUrl(signIn.baseUrl, "/device/token"), {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: signIn.deviceCode,
        client_id: TREVIZE_CODE_CLIENT_ID,
      });
      const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      if (response.status === 200) {
        const body = yield* decode(DeviceTokenResponse, response.status)(json);
        return body.access_token;
      }
      const error = yield* decode(DeviceErrorBody, response.status)(json);
      switch (error.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          intervalSeconds += SLOW_DOWN_SECONDS;
          continue;
        case "access_denied":
          return yield* new TrevizeApiError({
            reason: "unauthorized",
            status: response.status,
            message: "Sign-in was denied in Trevize.",
          });
        case "expired_token":
          return yield* new TrevizeApiError({
            reason: "timeout",
            status: response.status,
            message: "The sign-in code expired. Start again.",
          });
        default:
          return yield* new TrevizeApiError({
            reason: "request",
            status: response.status,
            message: error.error_description ?? `Trevize answered with ${error.error}.`,
          });
      }
    }
  },
);

/** API keys are long-lived and managed in Trevize; anything else is a session to revoke. */
export function isTrevizeApiKey(token: string): boolean {
  return /^(tvz_|tzv_)/.test(token.trim());
}

/**
 * Ends the Trevize session a device sign-in created. Best effort: signing out
 * here must work offline, and an expired session is already gone.
 */
export const revokeTrevizeSession = Effect.fn("clientRuntime.trevize.revokeSession")(function* (
  baseUrl: string,
  token: string,
) {
  if (isTrevizeApiKey(token)) return;
  const client = yield* HttpClient.HttpClient;
  yield* client
    .execute(
      HttpClientRequest.post(authUrl(baseUrl, "/sign-out")).pipe(
        HttpClientRequest.bearerToken(token.trim()),
        HttpClientRequest.bodyJsonUnsafe({}),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false), Effect.ignore);
});
