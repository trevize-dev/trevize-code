import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Trevize from "./commands";

export type TrevizeSleepState = "sleeping" | "waking" | null;

/**
 * Whether a saved environment is a stopped Trevize environment. A connected
 * environment never sleeps, whatever the last Trevize listing said.
 */
export function useTrevizeSleepState(
  environmentId: EnvironmentId | null,
  connected: boolean,
): TrevizeSleepState {
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  if (environmentId === null || connected) return null;
  if (sync.waking.has(environmentId)) return "waking";
  return sync.sleeping.has(environmentId) ? "sleeping" : null;
}

function reportWakeFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title: "Could not wake environment",
    description: error instanceof Error ? error.message : "Trevize did not wake it.",
  });
}

/** Wakes a sleeping Trevize environment once per environment, e.g. when one of its threads opens. */
export function useWakeSleepingTrevizeEnvironment(
  environmentId: EnvironmentId | null,
  connected: boolean,
) {
  const sleep = useTrevizeSleepState(environmentId, connected);
  const wake = useAtomCommand(Trevize.wakeEnvironment, { reportFailure: false });
  const attempted = useRef<EnvironmentId | null>(null);
  useEffect(() => {
    // Forget the attempt once it woke, so a later sleep wakes again.
    if (sleep === null) attempted.current = null;
    if (sleep !== "sleeping" || environmentId === null) return;
    if (attempted.current === environmentId) return;
    attempted.current = environmentId;
    void wake(environmentId).then(reportWakeFailure);
  }, [environmentId, sleep, wake]);
}

export function TrevizeWakeButton({
  environmentId,
  sleep,
}: {
  readonly environmentId: EnvironmentId;
  readonly sleep: TrevizeSleepState;
}) {
  const wake = useAtomCommand(Trevize.wakeEnvironment, { reportFailure: false });
  if (sleep === null) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={sleep === "waking"}
      onClick={() => void wake(environmentId).then(reportWakeFailure)}
    >
      {sleep === "waking" ? <Spinner size="sm" /> : null}
      Wake
    </Button>
  );
}
