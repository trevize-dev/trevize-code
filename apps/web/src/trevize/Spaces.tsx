import { useAtomValue } from "@effect/atom-react";
import {
  TrevizeMyTasks,
  TrevizeSpaces,
  TrevizeSync,
  type TrevizeApi,
} from "@t3tools/client-runtime/trevize";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { Button } from "~/components/ui/button";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { formatRelativeTime } from "~/timestampFormat";
import { useEnvironments } from "~/state/environments";
import * as Trevize from "./commands";
import { isSpaceIconName } from "./spaceIconOptions";

const SPACES_EXPANDED_STORAGE_KEY = "t3code:trevize:spaces-expanded:v1";

export type Space = TrevizeApi.TrevizeSpace;

export interface SpacesState {
  /** Signed in, and at least one workspace offers spaces. */
  readonly available: boolean;
  /** Most recent activity first. */
  readonly spaces: ReadonlyArray<Space>;
  readonly threads: ReadonlyArray<TrevizeApi.TrevizeThread>;
  readonly environments: ReadonlyArray<TrevizeApi.TrevizeEnvironment>;
  /** Whether the sync loop has listed Trevize at least once. */
  readonly loaded: boolean;
}

/**
 * Saved environment ids that run for a space. The native thread lists filter
 * them out: a space's orchestrator and agents live in the space, not in the
 * regular thread list.
 */
export function useSpaceEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const trevizeEnvironments = useAtomValue(Trevize.syncStateValueAtom).environments;
  const { environments: saved } = useEnvironments();
  return TrevizeSpaces.spaceEnvironmentIds(
    trevizeEnvironments,
    saved.map((environment) => environment.entry),
  );
}

/** Spaces from the Trevize Cloud sync loop. */
export function useSpaces(): SpacesState {
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  const available = TrevizeSync.hasCloudEnvironments(sync);
  const activity = new Map(
    sync.spaces.map((space) => [
      space.id,
      TrevizeSpaces.spaceActivityAt(space, sync.spaceThreads, sync.environments),
    ]),
  );
  return {
    available,
    spaces: available
      ? [...sync.spaces].sort((a, b) =>
          (activity.get(b.id) ?? "").localeCompare(activity.get(a.id) ?? ""),
        )
      : [],
    threads: sync.spaceThreads,
    environments: sync.environments,
    loaded: sync.lastSyncedAt !== null,
  };
}

/** Opens the New space dialog from anywhere (sidebar, command palette). */
export const useNewSpaceDialogStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

export function openNewSpaceDialog() {
  useNewSpaceDialogStore.getState().setOpen(true);
}

const SPACE_BADGE_TONES = [
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
] as const;

/**
 * A space's icon square: its chosen icon or emoji, else its initials. A
 * chosen color tints it; without one the tone is stable per space id.
 */
export function SpaceBadge({
  space,
  size = "sm",
}: {
  readonly space: Pick<Space, "id" | "name" | "icon" | "color">;
  readonly size?: "sm" | "lg";
}) {
  const icon = TrevizeSpaces.parseSpaceIcon(space.icon);
  const iconName = icon?.kind === "icon" && isSpaceIconName(icon.name) ? icon.name : null;
  const color = TrevizeSpaces.normalizeSpaceColor(space.color);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm leading-none font-semibold",
        size === "lg" ? "size-7 rounded-md text-xs" : "size-4 text-4xs",
        color === null &&
          SPACE_BADGE_TONES[TrevizeSpaces.spaceColorIndex(space.id, SPACE_BADGE_TONES.length)],
      )}
      style={
        color === null
          ? undefined
          : { color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }
      }
    >
      {iconName !== null ? (
        <DynamicIcon name={iconName} className={size === "lg" ? "size-4" : "size-3"} />
      ) : icon?.kind === "emoji" ? (
        <span className={size === "lg" ? "text-base" : "text-2xs"}>{icon.emoji}</span>
      ) : (
        TrevizeSpaces.spaceInitials(space.name)
      )}
    </span>
  );
}

const STATUS_DOT_CLASSES = {
  running: "border-info",
  waiting: "border-warning bg-warning",
  done: "border-success bg-success",
  failed: "border-destructive bg-destructive",
  sleeping: "border-muted-foreground/50",
  starting: "border-muted-foreground/50 border-dashed",
} as const satisfies Record<TrevizeMyTasks.MyTaskStatus, string>;

/** A thread's status as a small ring or dot, labelled for screen readers. */
export function ThreadStatusDot({ thread }: { readonly thread: TrevizeApi.TrevizeThread }) {
  const status = TrevizeMyTasks.deriveMyTaskStatus(thread);
  const label = status ? TrevizeMyTasks.MY_TASK_STATUS_LABELS[status] : "Unknown status";
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "size-2 shrink-0 rounded-full border",
        status ? STATUS_DOT_CLASSES[status] : "border-muted-foreground/30",
      )}
    />
  );
}

export function spaceThreadTitle(thread: TrevizeApi.TrevizeThread): string {
  return thread.title?.trim() || thread.branch?.trim() || "Untitled agent";
}

/** Compact age, e.g. `2m`, for dense rows. */
export function compactAge(iso: string): string {
  return formatRelativeTime(iso)?.value ?? "";
}

/**
 * "Spaces" sidebar group: each space's orchestrator chat and agents. Renders
 * nothing unless signed in to Trevize Cloud with spaces available.
 */
export function SpacesSidebarSection() {
  const { available, spaces, threads, environments } = useSpaces();
  const navigate = useNavigate();
  const activeSpaceId = useParams({
    strict: false,
    select: (params) => ("spaceId" in params ? params.spaceId : undefined),
  });
  const { isMobile, setOpenMobile } = useSidebar();
  const [expanded, setExpanded] = useLocalStorage(
    SPACES_EXPANDED_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  if (!available) return null;
  return (
    <section aria-label="Spaces" className="mb-2">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
            Spaces
          </CollapsibleSectionHeader>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="New space"
                onClick={openNewSpaceDialog}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>New space</TooltipPopup>
        </Tooltip>
      </div>
      {expanded ? (
        <SidebarMenu>
          {spaces.map((space) => {
            const needsYou = TrevizeSpaces.spaceNeedsYou(space.id, threads, environments);
            return (
              <SidebarMenuItem key={space.id}>
                <SidebarMenuButton
                  isActive={space.id === activeSpaceId}
                  onClick={() => {
                    void navigate({ to: "/spaces/$spaceId", params: { spaceId: space.id } });
                    if (isMobile) setOpenMobile(false);
                  }}
                >
                  <SpaceBadge space={space} />
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    {space.name}
                  </span>
                  {needsYou ? (
                    <span
                      role="img"
                      aria-label="Needs you"
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                    />
                  ) : null}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {compactAge(TrevizeSpaces.spaceActivityAt(space, threads, environments))}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          {spaces.length === 0 ? (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={openNewSpaceDialog}>
                <PlusIcon />
                <span>New space</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      ) : null}
    </section>
  );
}
