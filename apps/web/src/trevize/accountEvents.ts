/**
 * Fired after the Trevize credential is saved or cleared, so T3 Connect (which
 * signs in with the same Trevize account) re-reads who is signed in.
 */
const listeners = new Set<() => void>();

export function onTrevizeAccountChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTrevizeAccountChange(): void {
  for (const listener of listeners) listener();
}
