import { useAtomValue } from "@effect/atom-react";
import { TrevizeMyTasks, TrevizeSpaces, type TrevizeApi } from "@t3tools/client-runtime/trevize";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CircleDotIcon, CircleIcon, FileTextIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo } from "react";

import { useDirectoryEntries } from "~/components/files/useDirectoryEntries";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { deriveActivePlanState } from "~/session-logic";
import { useThreadProjection } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import * as Trevize from "./commands";
import { SpaceBadge, useSpaces } from "./Spaces";

/** Where `/shared` is mounted in every environment of a space. */
const SPACE_SHARED_ROOT = "/shared";

/**
 * Where a space thread opens on this device. `Saved` threads route by the
 * T3 server's own ids; others still need connecting through Trevize.
 */
export function useSpaceThreadTarget(
  thread: TrevizeApi.TrevizeThread | null,
): TrevizeMyTasks.MyTaskTarget | null {
  const { environments: saved } = useEnvironments();
  const trevizeEnvironments = useAtomValue(Trevize.syncStateValueAtom).environments;
  return useMemo(
    () =>
      thread === null
        ? null
        : TrevizeMyTasks.resolveMyTaskTarget(
            thread,
            trevizeEnvironments,
            saved.map((environment) => environment.entry),
          ),
    [saved, thread, trevizeEnvironments],
  );
}

export function savedThreadRef(target: TrevizeMyTasks.MyTaskTarget | null): ScopedThreadRef | null {
  return target?._tag === "Saved" ? scopeThreadRef(target.environmentId, target.threadId) : null;
}

/**
 * The "Space" right-panel surface: the orchestrator's current todo list and
 * the files in `/shared`, read through the space environment's T3 server.
 */
export function SpacePanel(props: {
  readonly spaceId: string;
  /** Reads `/shared` here until the orchestrator's environment is known. */
  readonly fallbackEnvironmentId: EnvironmentId;
  readonly onOpenFile: (absolutePath: string) => void;
}) {
  const { spaces, threads } = useSpaces();
  const space = spaces.find((candidate) => candidate.id === props.spaceId) ?? null;
  const orchestrator = space ? TrevizeSpaces.findOrchestratorThread(space, threads) : null;
  const orchestratorTarget = useSpaceThreadTarget(orchestrator);
  const orchestratorRef = useMemo(() => savedThreadRef(orchestratorTarget), [orchestratorTarget]);
  const projection = useThreadProjection(orchestratorRef)?.projection ?? null;
  const plan = useMemo(() => deriveActivePlanState(projection, undefined), [projection]);
  const filesEnvironmentId = orchestratorRef?.environmentId ?? props.fallbackEnvironmentId;

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
      {space ? (
        <div className="flex min-w-0 items-center gap-2">
          <SpaceBadge space={space} />
          <h2 className="truncate text-sm font-medium">{space.name}</h2>
        </div>
      ) : null}

      <section aria-label="Tasks" className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Tasks</h3>
        {plan === null ? (
          <p className="text-sm text-muted-foreground">No tasks yet</p>
        ) : (
          <ul className="space-y-1.5">
            {keyedSteps(plan.steps).map(({ key, step }) => (
              <li key={key} className="flex items-start gap-2 text-sm">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
                    step.status === "completed"
                      ? "text-success"
                      : step.status === "inProgress"
                        ? "text-primary"
                        : "text-muted-foreground/50",
                  )}
                >
                  {step.status === "completed" ? (
                    <CheckIcon aria-label="Completed" />
                  ) : step.status === "inProgress" ? (
                    <CircleDotIcon aria-label="Running" />
                  ) : (
                    <CircleIcon aria-label="Pending" />
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 wrap-anywhere",
                    step.status === "completed" && "text-muted-foreground",
                  )}
                >
                  {step.step}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SharedFiles
        key={filesEnvironmentId}
        environmentId={filesEnvironmentId}
        changedAt={projection?.updatedAt ?? null}
        onOpenFile={props.onOpenFile}
      />
    </div>
  );
}

/** Steps can repeat, so each is keyed by its text and occurrence. */
function keyedSteps<T extends { readonly step: string }>(steps: ReadonlyArray<T>) {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.step) ?? 0;
    seen.set(step.step, occurrence + 1);
    return { key: `${step.step}#${occurrence}`, step };
  });
}

function SharedFiles(props: {
  readonly environmentId: EnvironmentId;
  /** The orchestrator's last update; the list refreshes when it changes. */
  readonly changedAt: unknown;
  readonly onOpenFile: (absolutePath: string) => void;
}) {
  const { entries, load, refresh, isPending, ready, error } = useDirectoryEntries(
    props.environmentId,
    SPACE_SHARED_ROOT,
  );
  // `/shared` is small: load every folder so files show with their paths.
  useEffect(() => {
    for (const entry of entries) {
      if (entry.kind === "directory") void load(entry.path);
    }
  }, [entries, load]);
  const onChanged = useEffectEvent(() => refresh());
  useEffect(() => {
    if (props.changedAt !== null) onChanged();
  }, [props.changedAt]);
  const files = entries.filter((entry) => entry.kind === "file");

  return (
    <section aria-label={`Files in ${SPACE_SHARED_ROOT}`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Files in {SPACE_SHARED_ROOT}</h3>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Refresh files"
          disabled={isPending}
          onClick={refresh}
        >
          {isPending ? <Spinner size="xs" /> : <RotateCwIcon />}
        </Button>
      </div>
      {error !== null ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : !ready ? null : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files yet</p>
      ) : (
        <ul className="space-y-0.5">
          {files.map((file) => (
            <li key={file.path}>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => props.onOpenFile(`${SPACE_SHARED_ROOT}/${file.path}`)}
              >
                <FileTextIcon />
                <span className="min-w-0 truncate">{file.path}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
