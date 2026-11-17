import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  TrevizeRepositoryNotConnectedError,
  TrevizeSpaces,
  TrevizeSync,
} from "@t3tools/client-runtime/trevize";
import type { EnvironmentId, RepositoryIdentity, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  beginCloudLaunch,
  endCloudLaunch,
  setCloudLaunchPhase,
  takeCloudLaunchQueue,
} from "./cloudLaunches";
import {
  TREVIZE_SETTINGS_STORAGE_KEY,
  TrevizeClientSettings,
  archiveSession,
  defaultTrevizeSettings,
  launchSession,
  syncStateValueAtom,
} from "./commands";

const DEFAULT_SETTINGS = defaultTrevizeSettings();
const isRepositoryNotConnected = Schema.is(TrevizeRepositoryNotConnectedError);

/** Where cloud work on some repositories would run, as far as the last sync knows. */
export interface CloudPlacement {
  /** `unknown` when a workspace's repositories could not be listed; launching still tries. */
  readonly status: "connected" | "not-connected" | "unknown";
  /** The workspace it runs in, named only when the user has several. */
  readonly workspaceName: string | null;
  /** The Trevize page to connect the repositories on, when not connected anywhere. */
  readonly connectUrl: string | null;
}

const PLACEMENT_STATUS = {
  Connected: "connected",
  NotConnected: "not-connected",
  Unknown: "unknown",
} as const;

/** Places `repositoryIds` with the sync state; null when cloud work is unavailable. */
export function describeCloudPlacement(
  sync: TrevizeSync.TrevizeCloudSyncState,
  settings: Pick<TrevizeSync.TrevizeClientSettings, "baseUrl" | "workspaceId">,
  repositoryIds: ReadonlyArray<string>,
): CloudPlacement | null {
  if (!sync.signedIn) return null;
  const placement = TrevizeSpaces.placeRepositories({
    preferredWorkspaceId: settings.workspaceId,
    spaceWorkspaceIds: sync.spaceWorkspaceIds,
    connectedRepositories: sync.connectedRepositories,
    repositoryIds,
  });
  if (placement === null) return null;
  const workspace = sync.workspaces.find((candidate) => candidate.id === placement.workspaceId);
  const status = PLACEMENT_STATUS[placement._tag];
  return {
    status,
    workspaceName: sync.spaceWorkspaceIds.length > 1 ? (workspace?.name ?? null) : null,
    connectUrl:
      status === "not-connected" && workspace
        ? TrevizeSpaces.connectRepositoriesUrl(settings.baseUrl, workspace.slug)
        : null,
  };
}

const samePlacement = (a: CloudPlacement | null, b: CloudPlacement | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.status === b.status &&
    a.workspaceName === b.workspaceName &&
    a.connectUrl === b.connectUrl);

export function useTrevizeClientSettings(): TrevizeSync.TrevizeClientSettings {
  return useLocalStorage(TREVIZE_SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS, TrevizeClientSettings)[0];
}

/**
 * Where a cloud session for this project would run. Re-renders only when the
 * answer changes, not on every sync.
 */
export function useCloudSessionPlacement(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): CloudPlacement | null {
  const { baseUrl, workspaceId } = useTrevizeClientSettings();
  const repository = TrevizeSpaces.githubRepositorySlug(repositoryIdentity);
  const placementAtom = Atom.map(syncStateValueAtom, (sync) =>
    repository === null
      ? null
      : describeCloudPlacement(sync, { baseUrl, workspaceId }, [repository]),
  ).pipe(Atom.withEquality(samePlacement));
  return useAtomValue(placementAtom);
}

/**
 * The `owner/repo` a cloud session for this project would clone, or null when
 * it cannot run: signed out, no workspace with environments, no GitHub
 * remote, or a repository connected to none of the workspaces.
 */
export function useCloudSessionRepository(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): string | null {
  const placement = useCloudSessionPlacement(repositoryIdentity);
  return placement === null || placement.status === "not-connected"
    ? null
    : TrevizeSpaces.githubRepositorySlug(repositoryIdentity);
}

/** Opens a Trevize page in the system browser. */
export function openTrevizePage(url: string): void {
  void readLocalApi()?.shell.openExternal(url);
}

/**
 * Starts a cloud session from the draft at `key`, which shows its progress and
 * queues later sends (`cloudLaunches`). Opens the thread if `stillWanted()`,
 * else offers it on a toast. Resolves to null once launched, or to the queued
 * prompts the draft gets back when it fails.
 */
export function useLaunchCloudSession() {
  const navigate = useNavigate();
  const run = useAtomCommand(launchSession, { reportFailure: false });
  return async (
    key: string,
    input: TrevizeSync.LaunchSessionInput & { readonly displayPrompt: string },
    stillWanted: () => boolean,
  ): Promise<ReadonlyArray<string> | null> => {
    const { displayPrompt, ...launchInput } = input;
    beginCloudLaunch(key, {
      repository: input.repository,
      branch: input.branch ?? null,
      prompt: displayPrompt,
    });
    const result = await run({
      ...launchInput,
      onPhase: (phase) => setCloudLaunchPhase(key, phase),
      takeQueued: () => takeCloudLaunchQueue(key),
    });
    const launch = endCloudLaunch(key);
    if (result._tag === "Success") {
      const open = () =>
        navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(result.value) });
      if (result.value.unsent.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Some queued messages were not sent",
            description: result.value.unsent.join("\n\n"),
          }),
        );
      }
      if (stillWanted()) {
        await open();
      } else {
        const toastId = toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Cloud session started",
            description: TrevizeSync.cloudSessionTitle(displayPrompt),
            timeout: 20_000,
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(toastId);
                void open();
              },
            },
            data: { hideCopyButton: true },
          }),
        );
      }
      return null;
    }
    const queued = launch?.messages.slice(1).map((message) => message.text) ?? [];
    if (isAtomCommandInterrupted(result)) return queued;
    const error = squashAtomCommandFailure(result);
    const connectUrl = isRepositoryNotConnected(error) ? error.connectUrl : null;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start cloud session",
        description: error instanceof Error ? error.message : "Trevize did not start it.",
        ...(connectUrl
          ? {
              actionProps: {
                children: "Connect repository",
                onClick: () => {
                  toastManager.close(toastId);
                  openTrevizePage(connectUrl);
                },
              },
            }
          : {}),
      }),
    );
    return queued;
  };
}

const sameIds = (a: ReadonlySet<EnvironmentId>, b: ReadonlySet<EnvironmentId>) =>
  a.size === b.size && [...a].every((environmentId) => b.has(environmentId));

const cloudSessionEnvironmentIdsAtom = Atom.map(
  syncStateValueAtom,
  (sync): ReadonlySet<EnvironmentId> => new Set(sync.sessionEnvironments.keys()),
).pipe(Atom.withEquality(sameIds));

/** `readCloudSessionEnvironmentIds`, re-rendering only when the set changes. */
export function useCloudSessionEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return useAtomValue(cloudSessionEnvironmentIdsAtom);
}

/**
 * Saved environments of one-off cloud sessions. New threads never default to
 * them: their sandbox belongs to the session that started it.
 */
export function readCloudSessionEnvironmentIds(): ReadonlySet<EnvironmentId> {
  return appAtomRegistry.get(cloudSessionEnvironmentIdsAtom);
}

/**
 * Archives a cloud session in place of Settle. Needs only Trevize, so it works
 * while the sandbox sleeps. Asks first, since unpushed work goes with the
 * sandbox; a declined confirm resolves as interrupted.
 */
export function useArchiveCloudSession() {
  const run = useAtomCommand(archiveSession, { reportFailure: false });
  return async (target: ScopedThreadRef) => {
    const title = readThreadShells().find(
      (thread) => thread.environmentId === target.environmentId && thread.id === target.threadId,
    )?.title;
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        title ? `Archive cloud session "${title}"?` : "Archive this cloud session?",
        "Its sandbox stops and is removed. Push anything you want to keep first.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (confirmed === false) return AsyncResult.failure(Cause.interrupt());
    const result = await run(target.environmentId);
    if (result._tag === "Success") {
      toastManager.add(stackedThreadToast({ type: "success", title: "Cloud session archived" }));
    }
    return result;
  };
}
