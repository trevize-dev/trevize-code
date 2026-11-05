import type { EnvironmentId, RepositoryIdentity } from "@t3tools/contracts";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  normalizeTrevizeBaseUrl,
  type TrevizeEnvironment,
  type TrevizeRepository,
  type TrevizeSpace,
  type TrevizeSpacePatch,
  type TrevizeThread,
} from "./api.ts";
import { findSavedTrevizeEnvironment } from "./connect.ts";
import { deriveMyTaskStatus, myTaskActivityAt } from "./myTasks.ts";

/**
 * Spaces: an orchestrator thread plus the agent threads it hands work to, all
 * running in environments Trevize created for the space. A thread belongs to
 * a space through its environment's `spaceId`.
 */

export const MAX_SPACE_ENVIRONMENTS = 32;

/**
 * The saved (T3) environment ids of Trevize environments that run for a space.
 * Their threads are a space's orchestrator and agents, so the native thread
 * lists leave them to the space instead of listing them as regular threads.
 */
export function spaceEnvironmentIds(
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "httpBaseUrl" | "spaceId">>,
  saved: Iterable<ConnectionCatalogEntry>,
): ReadonlySet<EnvironmentId> {
  const entries = [...saved];
  const ids = new Set<EnvironmentId>();
  for (const environment of environments) {
    if (!environment.spaceId) continue;
    const environmentId = findSavedTrevizeEnvironment(entries, environment.httpBaseUrl);
    if (environmentId !== null) ids.add(environmentId);
  }
  return ids;
}
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

/** Whether a space's environment failed to start (its orchestrator waits for a restart). */
export function spaceEnvironmentFailed(
  spaceId: string,
  environments: ReadonlyArray<Pick<TrevizeEnvironment, "spaceId" | "status">>,
): boolean {
  return environments.some(
    (environment) => environment.spaceId === spaceId && environment.status === "failed",
  );
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

export type SpaceIcon =
  | { readonly kind: "icon"; readonly name: string }
  | { readonly kind: "emoji"; readonly emoji: string };

const SPACE_ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A space's stored icon: a kebab-case Lucide icon name, else an emoji; null shows initials. */
export function parseSpaceIcon(icon: string | null | undefined): SpaceIcon | null {
  const value = icon?.trim();
  if (!value) return null;
  return SPACE_ICON_NAME.test(value)
    ? { kind: "icon", name: value }
    : { kind: "emoji", emoji: value };
}

/** A space's stored color when it is `#rrggbb`, lowercased; anything else uses the default tone. */
export function normalizeSpaceColor(color: string | null | undefined): string | null {
  const value = color?.trim().toLowerCase();
  return value && /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/** What the space settings dialog edits. */
export interface SpaceSettingsDraft {
  readonly name: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly instructions: string;
  readonly maxEnvironments: number;
}

export function spaceSettingsDraft(
  space: Pick<TrevizeSpace, "name" | "icon" | "color" | "instructions" | "maxEnvironments">,
): SpaceSettingsDraft {
  return {
    name: space.name,
    icon: space.icon ?? null,
    color: normalizeSpaceColor(space.color),
    instructions: space.instructions ?? "",
    maxEnvironments: space.maxEnvironments ?? DEFAULT_SPACE_ENVIRONMENTS,
  };
}

/**
 * The fields of `draft` that differ from the space, or null when nothing
 * changed. Blank instructions clear them; a blank name is never sent.
 */
export function spaceSettingsPatch(
  space: Pick<TrevizeSpace, "name" | "icon" | "color" | "instructions" | "maxEnvironments">,
  draft: SpaceSettingsDraft,
): TrevizeSpacePatch | null {
  const current = spaceSettingsDraft(space);
  const name = draft.name.trim();
  const instructions = draft.instructions.trim() ? draft.instructions : null;
  const patch: { -readonly [K in keyof TrevizeSpacePatch]: TrevizeSpacePatch[K] } = {};
  if (name && name !== current.name) patch.name = name;
  if (draft.icon !== current.icon) patch.icon = draft.icon;
  if (draft.color !== current.color) patch.color = draft.color;
  if (instructions !== (current.instructions.trim() ? current.instructions : null)) {
    patch.instructions = instructions;
  }
  if (draft.maxEnvironments !== current.maxEnvironments) {
    patch.maxEnvironments = draft.maxEnvironments;
  }
  return Object.keys(patch).length > 0 ? patch : null;
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

/** The default workspace for cloud work: the one picked in settings when it has spaces, else the first that does. */
export function defaultSpaceWorkspaceId(
  preferred: string | null,
  available: ReadonlyArray<string>,
): string | null {
  if (preferred !== null && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

/** How `connectedRepositories` names a repository: its lowercased `owner/repo` and its Trevize id. */
export function connectedRepositoryKeys(
  repositories: ReadonlyArray<TrevizeRepository>,
): ReadonlySet<string> {
  return new Set(
    repositories.flatMap((repository) => [
      repository.fullName.toLowerCase(),
      String(repository.id),
    ]),
  );
}

/**
 * Where cloud work on some repositories runs: the first workspace, default
 * first, with all of them `Connected`. Otherwise the default workspace, where
 * to connect them (`NotConnected`) or a guess when some listing failed (`Unknown`).
 */
export type RepositoryPlacement =
  | { readonly _tag: "Connected"; readonly workspaceId: string }
  | { readonly _tag: "NotConnected"; readonly workspaceId: string }
  | { readonly _tag: "Unknown"; readonly workspaceId: string };

/** Places `repositoryIds` (`owner/repo` or Trevize ids); null when no workspace has environments. */
export function placeRepositories(input: {
  readonly preferredWorkspaceId: string | null;
  /** Workspaces with environments, as the sync lists them. */
  readonly spaceWorkspaceIds: ReadonlyArray<string>;
  /** Connected repository keys per workspace; a missing workspace is unknown. */
  readonly connectedRepositories: ReadonlyMap<string, ReadonlySet<string>>;
  readonly repositoryIds: ReadonlyArray<string>;
}): RepositoryPlacement | null {
  const preferred = defaultSpaceWorkspaceId(input.preferredWorkspaceId, input.spaceWorkspaceIds);
  if (preferred === null) return null;
  const candidates = [
    preferred,
    ...input.spaceWorkspaceIds.filter((candidate) => candidate !== preferred),
  ];
  const wanted = input.repositoryIds.map((repository) => repository.toLowerCase());
  const connected = candidates.find((workspaceId) => {
    const keys = input.connectedRepositories.get(workspaceId);
    return keys !== undefined && wanted.every((repository) => keys.has(repository));
  });
  if (connected !== undefined) return { _tag: "Connected", workspaceId: connected };
  if (wanted.length === 0) return { _tag: "Connected", workspaceId: preferred };
  const known = candidates.every((workspaceId) => input.connectedRepositories.has(workspaceId));
  return { _tag: known ? "NotConnected" : "Unknown", workspaceId: preferred };
}

/** The Trevize page where a workspace connects GitHub repositories. */
export function connectRepositoriesUrl(baseUrl: string, workspaceSlug: string): string {
  return `${normalizeTrevizeBaseUrl(baseUrl)}/${encodeURIComponent(workspaceSlug)}/settings/integrations/github`;
}

/** Space tabs: the space chat first, then opened agents. The active tab lives in the route; `null` is the orchestrator. */
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
