import type { RepositoryIdentity } from "@t3tools/contracts";

import type { TrevizeEnvironment, TrevizeSpace, TrevizeThread } from "./api.ts";
import { deriveMyTaskStatus, myTaskActivityAt } from "./myTasks.ts";

/**
 * Spaces: an orchestrator thread plus the agent threads it hands work to, all
 * running in environments Trevize created for the space. A thread belongs to
 * a space through its environment's `spaceId`.
 */

export const MAX_SPACE_ENVIRONMENTS = 32;
export const DEFAULT_SPACE_ENVIRONMENTS = 4;

/** Every thread of a space, the orchestrator included, in listing order. */
export function spaceThreads(
  spaceId: string,
  threads: ReadonlyArray<TrevizeThread>,
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "id" | "spaceId">>,
): ReadonlyArray<TrevizeThread> {
  const spaceEnvironments = new Set(
    environments.filter((environment) => environment.spaceId === spaceId).map(({ id }) => id),
  );
  return threads.filter((thread) => spaceEnvironments.has(thread.environmentId));
}

export function findOrchestratorThread(
  space: Pick<TrevizeSpace, "orchestratorThreadId">,
  threads: ReadonlyArray<TrevizeThread>,
): TrevizeThread | null {
  if (space.orchestratorThreadId === null) return null;
  return threads.find((thread) => thread.id === space.orchestratorThreadId) ?? null;
}

/** The space's agents: its live threads except the orchestrator, most recent activity first. */
export function spaceAgents(
  space: Pick<TrevizeSpace, "id" | "orchestratorThreadId">,
  threads: ReadonlyArray<TrevizeThread>,
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "id" | "spaceId">>,
): ReadonlyArray<TrevizeThread> {
  return spaceThreads(space.id, threads, environments)
    .filter((thread) => thread.id !== space.orchestratorThreadId && thread.archived !== true)
    .sort((a, b) => myTaskActivityAt(b).localeCompare(myTaskActivityAt(a)));
}

/** Whether any live thread of the space, the orchestrator included, waits on the user. */
export function spaceNeedsYou(
  spaceId: string,
  threads: ReadonlyArray<TrevizeThread>,
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "id" | "spaceId">>,
): boolean {
  return spaceThreads(spaceId, threads, environments).some(
    (thread) => thread.archived !== true && deriveMyTaskStatus(thread) === "waiting",
  );
}

/** The latest activity in a space: its own update or any of its threads'. */
export function spaceActivityAt(
  space: Pick<TrevizeSpace, "id" | "updatedAt">,
  threads: ReadonlyArray<TrevizeThread>,
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "id" | "spaceId">>,
): string {
  let latest = space.updatedAt;
  for (const thread of spaceThreads(space.id, threads, environments)) {
    const at = myTaskActivityAt(thread);
    if (at > latest) latest = at;
  }
  return latest;
}

/** Up to two letters for a space's badge: the first two words' initials, or one word's first two letters. */
export function spaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (first === undefined) return "?";
  const letters = second === undefined ? first.slice(0, 2) : `${first[0]}${second[0]}`;
  return letters.toUpperCase();
}

/** A stable index into a palette of `count` colors, so a space keeps its color everywhere. */
export function spaceColorIndex(spaceId: string, count: number): number {
  let hash = 0;
  for (let index = 0; index < spaceId.length; index++) {
    hash = (hash * 31 + spaceId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % Math.max(1, count);
}

/**
 * The `owner/repo` slug Trevize clones a project from, or null when the
 * project has no GitHub remote. A fork's own remote wins over its upstream,
 * since that is where agents push.
 */
export function githubRepositorySlug(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  if (!identity) return null;
  const key = identity.origin?.canonicalKey ?? identity.canonicalKey;
  // Canonical keys are `host/owner/repo`, lowercased.
  const [host, owner, repo, ...rest] = key.split("/").filter(Boolean);
  if (host !== "github.com" || !owner || !repo || rest.length > 0) return null;
  return `${owner}/${repo}`;
}

/** The workspace new spaces go to: the one picked in settings when it has spaces, else the first that does. */
export function defaultSpaceWorkspaceId(
  preferred: string | null,
  available: ReadonlyArray<string>,
): string | null {
  if (preferred !== null && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

// ---------------------------------------------------------------------------
// Tabs: the space chat first, then opened agents. The active tab lives in the
// route; `null` is the orchestrator.
// ---------------------------------------------------------------------------

export function openSpaceTab(tabs: ReadonlyArray<string>, threadId: string): ReadonlyArray<string> {
  return tabs.includes(threadId) ? tabs : [...tabs, threadId];
}

/** Closes a tab; closing the active one activates its right neighbour, else its left, else the space chat. */
export function closeSpaceTab(
  tabs: ReadonlyArray<string>,
  threadId: string,
  active: string | null,
): { readonly tabs: ReadonlyArray<string>; readonly active: string | null } {
  const index = tabs.indexOf(threadId);
  if (index === -1) return { tabs, active };
  const next = tabs.filter((tab) => tab !== threadId);
  if (active !== threadId) return { tabs: next, active };
  return { tabs: next, active: next[index] ?? next[index - 1] ?? null };
}
