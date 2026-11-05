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
import type { RepositoryIdentity } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  TREVIZE_SETTINGS_STORAGE_KEY,
  TrevizeClientSettings,
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
 * Starts a cloud session behind a progress toast. Opens the new thread when
 * `stillWanted()` says the user is still on the draft that started it, and
 * otherwise leaves an "Open" action on the toast. Resolves to whether it launched.
 */
export function useLaunchCloudSession() {
  const navigate = useNavigate();
  const run = useAtomCommand(launchSession, { reportFailure: false });
  return async (input: TrevizeSync.LaunchSessionInput, stillWanted: () => boolean) => {
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "loading",
        title: "Starting cloud session",
        description: `Preparing a sandbox for ${input.repository}. A cold start can take a few minutes.`,
        timeout: 0,
        data: { hideCopyButton: true },
      }),
    );
    const result = await run(input);
    if (result._tag === "Success") {
      const open = () =>
        navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(result.value) });
      if (stillWanted()) {
        toastManager.close(toastId);
        await open();
      } else {
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "success",
            title: "Cloud session started",
            description: TrevizeSync.cloudSessionTitle(input.prompt),
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
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      toastManager.close(toastId);
      return false;
    }
    const error = squashAtomCommandFailure(result);
    const connectUrl = isRepositoryNotConnected(error) ? error.connectUrl : null;
    toastManager.update(
      toastId,
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
    return false;
  };
}
