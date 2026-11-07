// Trevize: T3 Connect signs in with the Trevize account (Better Auth) instead of
// Clerk. This module stands in for the Clerk instance and the `useAuth` hook the
// upstream T3 Connect code reads, so those files only swap an import.
import type { CloudAccountSource } from "@t3tools/client-runtime/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { trevizeRelayTokenSubject } from "@t3tools/client-runtime/trevize";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { onTrevizeAccountChange } from "../trevize/accountEvents";
import * as Trevize from "../trevize/commands";

interface AccountSnapshot {
  /** False until the first lookup settles. */
  readonly isLoaded: boolean;
  readonly userId: string | null;
}

type AccountListener = Parameters<CloudAccountSource["addListener"]>[0];

let snapshot: AccountSnapshot = { isLoaded: false, userId: null };
// Whether the account is known; a failed first lookup leaves it unknown so the
// account service does not mistake a network error for a sign-out and clean up.
let known = false;
const accountListeners = new Set<AccountListener>();
const snapshotListeners = new Set<() => void>();

function publish(next: AccountSnapshot, isKnown: boolean): void {
  const changed = next.isLoaded !== snapshot.isLoaded || next.userId !== snapshot.userId;
  snapshot = next;
  if (isKnown) {
    known = true;
    const user = next.userId ? { id: next.userId } : null;
    for (const listener of accountListeners) listener({ user });
  }
  if (changed) for (const listener of snapshotListeners) listener();
}

/**
 * The relay token for the signed-in Trevize account, or null when signed out.
 * An ended session also signs T3 Connect out.
 */
export async function readTrevizeRelayToken(): Promise<string | null> {
  const result = await runAtomCommand(appAtomRegistry, Trevize.relayToken, undefined, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag !== "Success") {
    // Unreachable Trevize: keep who we think is signed in.
    publish({ isLoaded: true, userId: snapshot.userId }, false);
    return null;
  }
  const token = Option.getOrNull(result.value);
  publish({ isLoaded: true, userId: token ? trevizeRelayTokenSubject(token) : null }, true);
  return token;
}

/** Re-reads who is signed in, e.g. after the Trevize credential changed. */
export function refreshTrevizeAccount(): void {
  void readTrevizeRelayToken();
}

onTrevizeAccountChange(refreshTrevizeAccount);

/** The Trevize account as the T3 Connect account service observes it. */
export interface TrevizeAccountSource extends CloudAccountSource {
  readonly readRelayToken: () => Promise<string | null>;
}

export const trevizeAccountSource: TrevizeAccountSource = {
  addListener(listener) {
    accountListeners.add(listener);
    if (known) listener({ user: snapshot.userId ? { id: snapshot.userId } : null });
    else refreshTrevizeAccount();
    return () => {
      accountListeners.delete(listener);
    };
  },
  readRelayToken: readTrevizeRelayToken,
};

function subscribe(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/**
 * The subset of Clerk's `useAuth` the T3 Connect UI reads. `isSignedIn` is
 * undefined until the account is loaded, like Clerk's.
 */
export function useAuth(_options?: { readonly treatPendingAsSignedOut?: boolean }) {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return {
    isLoaded: current.isLoaded,
    isSignedIn: current.isLoaded ? current.userId !== null : undefined,
    userId: current.userId,
    getToken: (_options?: unknown) => readTrevizeRelayToken(),
  };
}
