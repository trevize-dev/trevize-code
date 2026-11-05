import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TrevizeApi } from "@t3tools/client-runtime/trevize";
import { useNavigate } from "@tanstack/react-router";

import * as Trevize from "./commands";

import { toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";

type MyTask = TrevizeApi.TrevizeThread;

/**
 * Opens a Trevize thread: wakes its sleeping environment, or connects it when
 * this device has not saved it, then navigates. `openingTaskId` is the thread
 * this caller is opening.
 */
export function useOpenMyTask() {
  const navigate = useNavigate();
  const run = useAtomCommand(Trevize.openTask, { reportFailure: false });
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null);
  const open = async (task: Pick<MyTask, "id" | "environmentId" | "runtimeThreadId">) => {
    setOpeningTaskId(task.id);
    const result = await run(task);
    setOpeningTaskId((current) => (current === task.id ? null : current));
    if (result._tag === "Success") {
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: result.value.environmentId,
          threadId: result.value.threadId,
        },
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not open task",
      description: error instanceof Error ? error.message : "Trevize could not open it.",
    });
  };
  return { open, openingTaskId };
}
