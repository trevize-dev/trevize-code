// Trevize: T3 Connect signs in with the Trevize account (Better Auth) instead of
// Clerk. This module stands in for the Clerk instance and the `useAuth` hook the
// upstream T3 Connect code reads, so those files only swap an import.
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createTrevizeAccount, type TrevizeAccount } from "@t3tools/client-runtime/trevize";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { onTrevizeAccountChange } from "../trevize/accountEvents";
import * as Trevize from "../trevize/commands";

export type TrevizeAccountSource = TrevizeAccount;

export const trevizeAccountSource = createTrevizeAccount(async () => {
  const result = await runAtomCommand(appAtomRegistry, Trevize.relayToken, undefined, {
    reportFailure: false,
    reportDefect: false,
  });
  return result._tag === "Success"
    ? { _tag: "Known", token: Option.getOrNull(result.value) }
    : { _tag: "Unknown" };
});

onTrevizeAccountChange(trevizeAccountSource.refresh);

/**
 * The subset of Clerk's `useAuth` the T3 Connect UI reads. `isSignedIn` is
 * undefined until the account is loaded, like Clerk's.
 */
export function useAuth(_options?: { readonly treatPendingAsSignedOut?: boolean }) {
  const current = useSyncExternalStore(
    trevizeAccountSource.subscribe,
    trevizeAccountSource.getSnapshot,
  );
  return {
    isLoaded: current.isLoaded,
    isSignedIn: current.isLoaded ? current.userId !== null : undefined,
    userId: current.userId,
    getToken: (_options?: unknown) => trevizeAccountSource.readRelayToken(),
  };
}
