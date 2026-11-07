import type { CloudAccountSource } from "../relay/cloudAccountService.ts";
import { trevizeRelayTokenSubject } from "./deviceAuth.ts";

/**
 * T3 Connect signs in with the Trevize account instead of Clerk. A Trevize
 * account stands in for the Clerk instance: the cloud account service observes
 * it, and the relay reads tokens from it. Web and mobile wrap it in a hook.
 */

/** A relay token lookup: `Unknown` when Trevize could not be reached. */
export type TrevizeRelayTokenLookup =
  | { readonly _tag: "Known"; readonly token: string | null }
  | { readonly _tag: "Unknown" };

export interface TrevizeAccountSnapshot {
  /** False until the first lookup settles. */
  readonly isLoaded: boolean;
  readonly userId: string | null;
}

export interface TrevizeAccount extends CloudAccountSource {
  /** The relay token for the signed-in account, or null; an ended session signs out. */
  readonly readRelayToken: () => Promise<string | null>;
  /** Re-reads who is signed in, e.g. after the Trevize credential changed. */
  readonly refresh: () => void;
  readonly getSnapshot: () => TrevizeAccountSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

type AccountListener = Parameters<CloudAccountSource["addListener"]>[0];

export function createTrevizeAccount(
  lookupRelayToken: () => Promise<TrevizeRelayTokenLookup>,
): TrevizeAccount {
  let snapshot: TrevizeAccountSnapshot = { isLoaded: false, userId: null };
  // Whether the account is known. A failed first lookup leaves it unknown so the
  // account service does not mistake a network error for a sign-out and clean up.
  let known = false;
  const accountListeners = new Set<AccountListener>();
  const snapshotListeners = new Set<() => void>();

  const publish = (userId: string | null, isKnown: boolean) => {
    const changed = !snapshot.isLoaded || snapshot.userId !== userId;
    if (changed) snapshot = { isLoaded: true, userId };
    if (isKnown) {
      known = true;
      for (const listener of accountListeners) listener({ user: userId ? { id: userId } : null });
    }
    if (changed) for (const listener of snapshotListeners) listener();
  };

  const readRelayToken = async () => {
    const lookup = await lookupRelayToken();
    if (lookup._tag === "Unknown") {
      // Unreachable Trevize: keep who we think is signed in.
      publish(snapshot.userId, false);
      return null;
    }
    publish(lookup.token ? trevizeRelayTokenSubject(lookup.token) : null, true);
    return lookup.token;
  };

  const refresh = () => {
    void readRelayToken();
  };

  return {
    addListener(listener) {
      accountListeners.add(listener);
      if (known) listener({ user: snapshot.userId ? { id: snapshot.userId } : null });
      else refresh();
      return () => {
        accountListeners.delete(listener);
      };
    },
    readRelayToken,
    refresh,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
  };
}
