import type { ReactNode } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CloudAlertIcon, LifeBuoyIcon, MoonIcon } from "lucide-react";

import * as Trevize from "./commands";
import {
  TREVIZE_START_STEPS,
  type TrevizeEnvironmentNotice,
  type TrevizeStartStep,
} from "./startProgress.logic";
import { reportWakeFailure } from "./TrevizeWake";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

/** One segment per start step: done, current (pulsing), and still to come. */
function TrevizeStartSteps({
  stepNumber,
  recovering,
}: {
  readonly stepNumber: number;
  readonly recovering: boolean;
}) {
  return (
    <div className="flex gap-1 pb-1.5" aria-hidden="true">
      {TREVIZE_START_STEPS.map((step, index) => (
        <span
          key={step}
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-300",
            index + 1 < stepNumber
              ? recovering
                ? "bg-warning"
                : "bg-info"
              : index + 1 === stepNumber
                ? cn(recovering ? "bg-warning/60" : "bg-info/60", "motion-safe:animate-pulse")
                : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

/**
 * The composer notice for a Trevize environment that is not connected. It
 * leads with the state so a long environment title cannot truncate it away.
 */
export function useTrevizeStartBannerItem(input: {
  readonly environmentId: EnvironmentId | null;
  readonly notice: TrevizeEnvironmentNotice | null;
  /** Extra actions, e.g. disconnecting the server. */
  readonly actions?: ReactNode;
}): ComposerBannerStackItem | null {
  const gt = useGT();
  const wake = useAtomCommand(Trevize.wakeEnvironment, { reportFailure: false });
  const { environmentId, notice } = input;
  if (environmentId === null || notice === null) return null;
  const id = `trevize-environment:${environmentId}`;
  const wakeNow = () => void wake(environmentId).then(reportWakeFailure);

  switch (notice.kind) {
    case "asleep":
      return {
        id,
        variant: "default",
        group: "environment",
        icon: <MoonIcon />,
        title: gt("Sandbox is asleep"),
        description: gt("It stopped after a while without activity."),
        actions: (
          <>
            <Button size="xs" variant="ghost" onClick={wakeNow}>
              <T>Wake</T>
            </Button>
            {input.actions}
          </>
        ),
      };
    case "failed":
      return {
        id,
        variant: "error",
        group: "environment",
        icon: <CloudAlertIcon />,
        title: gt("Sandbox failed to start"),
        description: notice.error ?? undefined,
        actions: (
          <>
            <Button size="xs" variant="ghost" onClick={wakeNow}>
              <T>Try again</T>
            </Button>
            {input.actions}
          </>
        ),
      };
    case "starting": {
      const stepText = startStepText(gt, notice.step, notice);
      return {
        id,
        variant: notice.recovering ? "warning" : "info",
        group: "environment",
        icon: notice.recovering ? <LifeBuoyIcon /> : <Spinner />,
        title: notice.recovering ? gt("Rebuilding the sandbox") : gt("Waking the sandbox"),
        description: gt("Step {current} of {total}: {step}", {
          current: notice.stepNumber,
          total: TREVIZE_START_STEPS.length,
          step: stepText,
        }),
        children: (
          <>
            <TrevizeStartSteps stepNumber={notice.stepNumber} recovering={notice.recovering} />
            {notice.recovering ? (
              <p className="pb-1.5 text-muted-foreground text-xs">
                <T>
                  The old sandbox failed on the provider. Trevize is starting a new one from your
                  pushed branches. Unpushed changes and earlier conversations on the old sandbox are
                  lost.
                </T>
              </p>
            ) : null}
          </>
        ),
        actions: input.actions,
      };
    }
  }
}

function startStepText(
  gt: ReturnType<typeof useGT>,
  step: TrevizeStartStep,
  notice: { readonly recovering: boolean; readonly replacingSandbox: boolean },
): string {
  switch (step) {
    case "sandbox":
      return notice.replacingSandbox ? gt("Creating a new sandbox") : gt("Starting the sandbox");
    case "network":
      return gt("Securing network access");
    case "repositories":
      return notice.recovering ? gt("Restoring pushed branches") : gt("Checking out repositories");
    case "runtime":
      return gt("Starting Trevize Code");
  }
}
