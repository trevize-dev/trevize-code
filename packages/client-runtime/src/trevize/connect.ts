import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BearerConnectionCredential, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import { connectionRoutes } from "../connection/routes.ts";
import { connectWhenReady, type TrevizeApiConfig, type TrevizeEnvironment } from "./api.ts";

/**
 * The Trevize API key lives in the connection credential store (desktop secure
 * storage, the browser's connection catalog, the mobile keychain) under this
 * id. No route references it, so catalog route cleanup never drops it.
 */
const TREVIZE_API_KEY_CREDENTIAL_ID = "trevize:api-key";

export const loadTrevizeApiKey = Effect.fn("clientRuntime.trevize.loadApiKey")(function* () {
  const store = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const credential = yield* store.get(TREVIZE_API_KEY_CREDENTIAL_ID);
  return Option.map(credential, (value) => value.token);
});

export const saveTrevizeApiKey = Effect.fn("clientRuntime.trevize.saveApiKey")(function* (
  apiKey: string,
) {
  const store = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  yield* store.put(
    TREVIZE_API_KEY_CREDENTIAL_ID,
    new BearerConnectionCredential({ token: apiKey.trim() }),
  );
});

export const clearTrevizeApiKey = Effect.fn("clientRuntime.trevize.clearApiKey")(function* () {
  const store = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  yield* store.remove(TREVIZE_API_KEY_CREDENTIAL_ID);
});

/**
 * Connects a Trevize environment: asks Trevize for a one-time pairing token
 * (waking the sandbox if needed), then redeems it with the ordinary pairing
 * flow. The saved route is keyed by the environment's stable gateway origin,
 * so connecting again re-pairs and replaces the credential instead of adding
 * a second environment.
 */
export const connectTrevizeEnvironment = Effect.fn("clientRuntime.trevize.connectEnvironment")(
  function* (input: {
    readonly config: TrevizeApiConfig;
    readonly environment: Pick<TrevizeEnvironment, "id" | "title">;
    readonly maxWaitMs?: number;
  }) {
    const ready = yield* connectWhenReady(
      input.config,
      input.environment.id,
      input.maxWaitMs === undefined ? undefined : { maxWaitMs: input.maxWaitMs },
    );
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    const label = input.environment.title?.trim() || ready.label;
    return yield* onboarding.registerPairing({
      host: ready.httpBaseUrl,
      pairingCode: ready.pairingToken,
      ...(label ? { label } : {}),
      // The sandbox reports its container addresses, which only the gateway
      // can reach; learning them would add a dead "LAN" route.
      learnRoutes: false,
    });
  },
);

/** The origin Trevize environments are matched by, or null for an invalid URL. */
export function trevizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The saved environment reached at a Trevize environment's gateway origin, if
 * any. Trevize environments have a stable `httpBaseUrl`, so the saved bearer
 * route is how this client recognises one it already paired.
 */
export function findSavedTrevizeEnvironment(
  entries: Iterable<ConnectionCatalogEntry>,
  httpBaseUrl: string,
): EnvironmentId | null {
  const origin = trevizeOrigin(httpBaseUrl);
  if (origin === null) return null;
  for (const entry of entries) {
    const matches = connectionRoutes(entry).some(
      (route) =>
        Option.isSome(route.profile) &&
        route.profile.value._tag === "BearerConnectionProfile" &&
        trevizeOrigin(route.profile.value.httpBaseUrl) === origin,
    );
    if (matches) return entry.target.environmentId;
  }
  return null;
}
