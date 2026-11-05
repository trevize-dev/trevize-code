import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TrevizeSpaces, TrevizeSync } from "@t3tools/client-runtime/trevize";
import type { RepositoryIdentity } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";

import { launchSession, syncStateValueAtom } from "./commands";

/** Signed in to Trevize Cloud with a workspace that has environments enabled. */
const cloudSessionsEnabledAtom = Atom.make((get) => {
  const sync = get(syncStateValueAtom);
  return sync.signedIn && sync.spaceWorkspaceIds.length > 0;
}).pipe(Atom.withLabel("trevize-cloud-sessions-enabled"));

/**
 * The `owner/repo` a cloud session for this project would clone, or null when
 * cloud sessions are unavailable: signed out, no workspace with environments,
 * or a project without a GitHub remote.
 */
export function useCloudSessionRepository(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): string | null {
  const enabled = useAtomValue(cloudSessionsEnabledAtom);
  return enabled ? TrevizeSpaces.githubRepositorySlug(repositoryIdentity) : null;
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
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: result.value.environmentId,
            threadId: result.value.threadId,
          },
        });
      if (stillWanted()) {
        toastManager.close(toastId);
        await open();
      } else {
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "success",
            title: "Cloud session started",
            description: TrevizeSync.cloudSessionTitle(input),
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
    toastManager.update(
      toastId,
      stackedThreadToast({
        type: "error",
        title: "Could not start cloud session",
        description: error instanceof Error ? error.message : "Trevize did not start it.",
      }),
    );
    return false;
  };
}
