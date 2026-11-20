// Trevize: T3 Connect signs in with the Trevize account and never mounts Clerk, so there
// is no Clerk script whose load can fail. Upstream callers keep their retry UI unused.
// oxlint-disable-next-line t3code/no-hookless-use-function -- stands in for the Clerk hook upstream callers use; keeping the hook name keeps their call sites unchanged.
export function useClerkLoadFailed() {
  return false;
}

export function retryClerkLoad() {
  window.location.reload();
}
