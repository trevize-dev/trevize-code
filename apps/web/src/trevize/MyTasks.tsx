import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TrevizeMyTasks, type TrevizeApi } from "@t3tools/client-runtime/trevize";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import * as Schema from "effect/Schema";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import * as Trevize from "./commands";

const MY_TASKS_EXPANDED_STORAGE_KEY = "t3code:trevize:my-tasks-expanded:v1";
/** Rows shown before "Show all"; the sidebar is for what is current. */
const COLLAPSED_ROW_LIMIT = 5;

type MyTask = TrevizeApi.TrevizeThread;

const STATUS_BADGE_VARIANTS = {
  running: "info",
  waiting: "warning",
  done: "success",
  failed: "error",
  sleeping: "secondary",
  starting: "secondary",
} as const satisfies Record<TrevizeMyTasks.MyTaskStatus, string>;

/** The signed-in user's Trevize tasks, from the Trevize Cloud sync loop. */
export function useMyTasks(): ReadonlyArray<MyTask> {
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  return sync.signedIn ? sync.myTasks : [];
}

/**
 * Opens a task's thread: wakes its sleeping environment, or connects it when
 * this device has not saved it, then navigates. `openingTaskId` is the task
 * this caller is opening.
 */
export function useOpenMyTask() {
  const navigate = useNavigate();
  const run = useAtomCommand(Trevize.openTask, { reportFailure: false });
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null);
  const open = useCallback(
    async (task: MyTask) => {
      setOpeningTaskId(task.id);
      const result = await run(task);
      setOpeningTaskId((current) => (current === task.id ? null : current));
      if (result._tag === "Success") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: result.value.environmentId, threadId: result.value.threadId },
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
    },
    [navigate, run],
  );
  return { open, openingTaskId };
}

export function myTaskTitle(task: MyTask): string {
  return task.title?.trim() || task.branch?.trim() || "Untitled task";
}

function MyTaskRow(props: {
  readonly task: MyTask;
  readonly opening: boolean;
  readonly onOpen: (task: MyTask) => void;
}) {
  const { task } = props;
  const status = TrevizeMyTasks.deriveMyTaskStatus(task);
  const sourceLabel = TrevizeMyTasks.myTaskSourceLabel(task);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        disabled={props.opening}
        onClick={() => props.onOpen(task)}
        title={
          task.environmentTitle ? `${myTaskTitle(task)} · ${task.environmentTitle}` : undefined
        }
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {props.opening ? <Spinner size="xs" /> : null}
            <span className="truncate text-sidebar-foreground">{myTaskTitle(task)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            {status ? (
              <Badge size="sm" variant={STATUS_BADGE_VARIANTS[status]}>
                {TrevizeMyTasks.MY_TASK_STATUS_LABELS[status]}
              </Badge>
            ) : null}
            <span className="truncate">
              {formatRelativeTimeLabel(TrevizeMyTasks.myTaskActivityAt(task))}
            </span>
          </span>
        </span>
      </SidebarMenuButton>
      {/* A sibling of the row button, so the link is not nested in it. */}
      <span className="absolute right-2 bottom-2">
        {task.sourceUrl ? (
          <Badge
            size="sm"
            variant="outline"
            render={<a href={task.sourceUrl} target="_blank" rel="noreferrer" />}
          >
            {sourceLabel}
          </Badge>
        ) : (
          <Badge size="sm" variant="outline">
            {sourceLabel}
          </Badge>
        )}
      </span>
    </SidebarMenuItem>
  );
}

/**
 * "My tasks" sidebar group: Trevize threads assigned to the user. Renders
 * nothing unless signed in to Trevize Cloud with at least one task.
 */
export function MyTasksSidebarSection() {
  const tasks = useMyTasks();
  const { open, openingTaskId } = useOpenMyTask();
  const { isMobile, setOpenMobile } = useSidebar();
  const [expanded, setExpanded] = useLocalStorage(
    MY_TASKS_EXPANDED_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [showAll, setShowAll] = useState(false);
  if (tasks.length === 0) return null;
  const visible = showAll ? tasks : tasks.slice(0, COLLAPSED_ROW_LIMIT);
  const onOpen = (task: MyTask) => {
    void open(task).then(() => {
      if (isMobile) setOpenMobile(false);
    });
  };
  return (
    <section aria-label="My tasks" className="mb-2">
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        My tasks
      </CollapsibleSectionHeader>
      {expanded ? (
        <>
          <SidebarMenu>
            {visible.map((task) => (
              <MyTaskRow
                key={task.id}
                task={task}
                opening={openingTaskId === task.id}
                onOpen={onOpen}
              />
            ))}
          </SidebarMenu>
          {tasks.length > COLLAPSED_ROW_LIMIT ? (
            <Button size="xs" variant="ghost-muted" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${tasks.length}`}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
