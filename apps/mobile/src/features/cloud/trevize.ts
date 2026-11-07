// Trevize: T3 Connect on mobile signs in with a Trevize account through the
// device flow, and exchanges the session for the relay token.
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  TrevizeApi,
  awaitTrevizeDeviceSignIn,
  clearTrevizeApiKey,
  fetchTrevizeRelayToken,
  loadTrevizeApiKey,
  revokeTrevizeSession,
  saveTrevizeApiKey,
  startTrevizeDeviceSignIn,
  type TrevizeDeviceSignIn,
} from "@t3tools/client-runtime/trevize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../../connection/runtime";

const TREVIZE_URL = TrevizeApi.DEFAULT_TREVIZE_API_URL;

/** The short-lived relay token for the signed-in Trevize account, if any. */
export const relayToken = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:trevize:relay-token",
  execute: (_input: void) =>
    loadTrevizeApiKey().pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (sessionToken) => fetchTrevizeRelayToken(TREVIZE_URL, sessionToken),
        }),
      ),
    ),
});

/** Asks Trevize for a code the user approves in their browser. */
export const startDeviceSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:trevize:start-device-sign-in",
  execute: (_input: void) => startTrevizeDeviceSignIn(TREVIZE_URL),
});

/** Ends with an interrupt when `signal` aborts, e.g. on Cancel or leaving the screen. */
const abortedBy = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

/** Waits for the user to approve the code, then stores the session it grants. */
export const completeDeviceSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:trevize:complete-device-sign-in",
  execute: (input: { readonly signIn: TrevizeDeviceSignIn; readonly signal: AbortSignal }) =>
    awaitTrevizeDeviceSignIn(input.signIn).pipe(
      Effect.raceFirst(abortedBy(input.signal)),
      Effect.flatMap(saveTrevizeApiKey),
    ),
});

/** Ends the Trevize session and forgets it. */
export const signOut = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:trevize:sign-out",
  execute: (_input: void) =>
    loadTrevizeApiKey().pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (sessionToken) => revokeTrevizeSession(TREVIZE_URL, sessionToken),
        }),
      ),
      Effect.andThen(clearTrevizeApiKey()),
    ),
});
