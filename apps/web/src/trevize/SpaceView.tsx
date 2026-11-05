import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { TrevizeSpaces, type TrevizeApi } from "@t3tools/client-runtime/trevize";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import ChatView from "~/components/ChatView";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Trevize from "./commands";
import { savedThreadRef, useSpaceThreadTarget } from "./SpacePanel";
import { openSpaceSettings, useArchiveSpace } from "./SpaceSettingsDialog";
import {
  SpaceBadge,
  ThreadStatusDot,
  compactAge,
  spaceThreadTitle,
  useSpaces,
  type Space,
  type SpacesState,
} from "./Spaces";
import { useWakeSleepingTrevizeEnvironment } from "./TrevizeWake";

const SpaceTabs = Schema.Array(Schema.String);
const NO_TABS: ReadonlyArray<string> = [];
const spaceTabsStorageKey = (spaceId: string) => `t3code:trevize:space-tabs:v1:${spaceId}`;

/** Threads whose space panel this session already opened, so closing it sticks. */
const spacePanelOpened = new Set<string>();

/**
 * A space: its orchestrator chat as the first tab, then agent threads the
 * user opened. `tab` is the active agent's Trevize thread id; absent is the
 * orchestrator.
 */
export function SpaceView({ spaceId, tab }: { readonly spaceId: string; readonly tab?: string }) {
  const state = useSpaces();
  const space = state.spaces.find((candidate) => candidate.id === spaceId) ?? null;
  if (space === null) {
    return (
      <SpacePage titleRow={null}>
        {state.loaded ? (
          <SpaceEmpty
            title="Space unavailable"
            description="This space was archived, or Trevize Cloud doesn't list it for your account."
          />
        ) : (
          <SpaceEmpty title="Loading space" busy />
        )}
      </SpacePage>
    );
  }
  return <SpaceContent key={space.id} space={space} tab={tab ?? null} state={state} />;
}

function SpacePage({ titleRow, children }: { titleRow: ReactNode; children: ReactNode }) {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <WorkspacePageHeader electron={isElectron}>{titleRow}</WorkspacePageHeader>
      {children}
    </SidebarInset>
  );
}

function SpaceEmpty(props: {
  readonly title: string;
  readonly description?: string;
  readonly busy?: boolean;
  readonly action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        {props.busy ? <Spinner /> : null}
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

function SpaceContent({
  space,
  tab,
  state,
}: {
  readonly space: Space;
  readonly tab: string | null;
  readonly state: SpacesState;
}) {
  const navigate = useNavigate();
  const threads = TrevizeSpaces.spaceThreads(space.id, state.threads, state.environments);
  const agents = TrevizeSpaces.spaceAgents(space, state.threads, state.environments);
  const orchestrator = TrevizeSpaces.findOrchestratorThread(space, threads);
  const [openTabs, setOpenTabs] = useLocalStorage(
    spaceTabsStorageKey(space.id),
    NO_TABS,
    SpaceTabs,
  );
  const activeThread =
    tab === null ? orchestrator : (threads.find((thread) => thread.id === tab) ?? null);

  const selectTab = (threadId: string | null) =>
    void navigate({
      to: "/spaces/$spaceId",
      params: { spaceId: space.id },
      search: threadId === null ? {} : { tab: threadId },
    });
  const openAgent = (thread: TrevizeApi.TrevizeThread) => {
    setOpenTabs((current) => TrevizeSpaces.openSpaceTab(current, thread.id));
    selectTab(thread.id);
  };
  const closeTab = (threadId: string) => {
    const next = TrevizeSpaces.closeSpaceTab(openTabs, threadId, tab);
    setOpenTabs(next.tabs);
    if (next.active !== tab) selectTab(next.active);
  };
  // A link straight to an agent (e.g. from the palette) opens its tab too. Keyed
  // on the route only: closing the active tab drops it before the navigation
  // away lands, and reacting to `openTabs` would re-add it in between.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the routed tab into the persisted open-tabs list
  useEffect(() => {
    if (tab !== null) setOpenTabs((current) => TrevizeSpaces.openSpaceTab(current, tab));
  }, [setOpenTabs, tab]);

  const target = useSpaceThreadTarget(activeThread);
  const ref = savedThreadRef(target);
  const shell = useThreadShell(ref);
  const environment = useEnvironment(ref?.environmentId ?? null);
  // ChatView wakes its own environment; this covers the wait before it mounts.
  useWakeSleepingTrevizeEnvironment(
    ref?.environmentId ?? null,
    environment?.connection.phase === "connected",
  );
  const connectError = useConnectSpaceThread(activeThread, target?._tag === "Connect");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the space panel in the right-panel store the first time each thread shows
  useEffect(() => {
    if (ref === null) return;
    const key = scopedThreadKey(ref);
    if (spacePanelOpened.has(key)) return;
    spacePanelOpened.add(key);
    useRightPanelStore.getState().openSpace(ref, space.id, true);
  }, [ref, space.id]);

  const handleNewThread = useNewThreadHandler();
  const orchestratorTarget = useSpaceThreadTarget(orchestrator);
  const orchestratorShell = useThreadShell(savedThreadRef(orchestratorTarget));
  // New agents start in the project of the thread on screen, else the orchestrator's.
  const projectShell = shell ?? orchestratorShell;
  const newAgentProject =
    projectShell === null
      ? null
      : scopeProjectRef(projectShell.environmentId, projectShell.projectId);

  const titleRow = (
    <SpaceTabBar
      space={space}
      threads={threads}
      agents={agents}
      openTabs={openTabs}
      active={tab}
      onSelect={selectTab}
      onClose={closeTab}
      onOpenAgent={openAgent}
      onNewAgent={newAgentProject === null ? null : () => void handleNewThread(newAgentProject)}
    />
  );

  if (ref !== null && shell !== null) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
        <ChatView
          environmentId={ref.environmentId}
          threadId={ref.threadId}
          routeKind="server"
          titleRow={titleRow}
        />
      </SidebarInset>
    );
  }
  return (
    <SpacePage titleRow={titleRow}>
      <SpaceThreadPending
        space={space}
        tab={tab}
        thread={activeThread}
        state={state}
        target={target}
        connectError={connectError}
        onBack={() => selectTab(null)}
      />
    </SpacePage>
  );
}

/** Connects a space thread's environment through Trevize once, when this device hasn't saved it. */
function useConnectSpaceThread(thread: TrevizeApi.TrevizeThread | null, needed: boolean) {
  const connect = useAtomCommand(Trevize.openTask, { reportFailure: false });
  const attempted = useRef(new Set<string>());
  const [error, setError] = useState<{ threadId: string; message: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks Trevize to connect the thread's environment once when this device lacks it
  useEffect(() => {
    if (!needed || thread === null || attempted.current.has(thread.id)) return;
    attempted.current.add(thread.id);
    void connect(thread).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      setError({
        threadId: thread.id,
        message: cause instanceof Error ? cause.message : "Trevize could not connect it.",
      });
    });
  }, [connect, needed, thread]);
  return thread !== null && error?.threadId === thread.id ? error.message : null;
}

function SpaceThreadPending(props: {
  readonly space: Space;
  readonly tab: string | null;
  readonly thread: TrevizeApi.TrevizeThread | null;
  readonly state: SpacesState;
  readonly target: ReturnType<typeof useSpaceThreadTarget>;
  readonly connectError: string | null;
  readonly onBack: () => void;
}) {
  if (props.tab !== null && props.thread === null) {
    return (
      <SpaceEmpty
        title="Agent not found"
        description="This agent is no longer listed in the space."
        action={
          <Button size="sm" variant="outline" onClick={props.onBack}>
            Back to the space chat
          </Button>
        }
      />
    );
  }
  if (props.thread === null) {
    // Trevize launches the orchestrator once the space's first sandbox runs.
    const failed = TrevizeSpaces.spaceEnvironmentFailed(props.space.id, props.state.environments);
    return failed ? (
      <SpaceEmpty
        title="The space's sandbox didn't start"
        description="Reconnect it under Settings → Connections. The orchestrator starts once it runs."
      />
    ) : (
      <SpaceEmpty
        busy
        title="Starting the orchestrator"
        description="The space's first sandbox is starting. This can take a few minutes."
      />
    );
  }
  if (props.target?._tag === "Unavailable") {
    return <SpaceEmpty title="Can't open this thread" description={props.target.reason} />;
  }
  if (props.connectError !== null) {
    return <SpaceEmpty title="Couldn't connect" description={props.connectError} />;
  }
  return (
    <SpaceEmpty
      busy
      title="Opening"
      description="Connecting to the space's environment. A sleeping sandbox takes a minute to wake."
    />
  );
}

const TAB_CLASS =
  "flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const tabTone = (active: boolean) =>
  active
    ? "bg-accent text-foreground"
    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground";

function SpaceTabBar(props: {
  readonly space: Space;
  readonly threads: ReadonlyArray<TrevizeApi.TrevizeThread>;
  readonly agents: ReadonlyArray<TrevizeApi.TrevizeThread>;
  readonly openTabs: ReadonlyArray<string>;
  readonly active: string | null;
  readonly onSelect: (threadId: string | null) => void;
  readonly onClose: (threadId: string) => void;
  readonly onOpenAgent: (thread: TrevizeApi.TrevizeThread) => void;
  /** Null while no project of the space is known on this device. */
  readonly onNewAgent: (() => void) | null;
}) {
  const tabs = props.openTabs.flatMap((id) => {
    const thread = props.threads.find((candidate) => candidate.id === id);
    return thread && thread.id !== props.space.orchestratorThreadId ? [thread] : [];
  });
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div role="tablist" aria-label={props.space.name} className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={props.active === null}
          className={cn(TAB_CLASS, "max-w-56", tabTone(props.active === null))}
          onClick={() => props.onSelect(null)}
        >
          <SpaceBadge space={props.space} />
          <span className="truncate font-medium">{props.space.name}</span>
        </button>
        {tabs.map((thread) => {
          const active = props.active === thread.id;
          const title = spaceThreadTitle(thread);
          return (
            <div
              key={thread.id}
              className={cn(TAB_CLASS, "group/tab max-w-52 pr-1 pl-1.5", tabTone(active))}
            >
              <PanelTabCloseButton
                label={`Close ${title}`}
                onClick={() => props.onClose(thread.id)}
              >
                <ThreadStatusDot thread={thread} />
              </PanelTabCloseButton>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="min-w-0 cursor-pointer truncate pr-1 outline-none"
                onClick={() => props.onSelect(thread.id)}
              >
                {title}
              </button>
            </div>
          );
        })}
      </div>
      <AgentPicker agents={props.agents} onOpen={props.onOpenAgent} onNewAgent={props.onNewAgent} />
      <span className="flex-1" />
      <SpaceMenu space={props.space} />
    </div>
  );
}

function AgentPicker(props: {
  readonly agents: ReadonlyArray<TrevizeApi.TrevizeThread>;
  readonly onOpen: (thread: TrevizeApi.TrevizeThread) => void;
  readonly onNewAgent: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? props.agents.filter((agent) => spaceThreadTitle(agent).toLowerCase().includes(needle))
    : props.agents;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Open an agent" />}
      >
        <PlusIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact" width="md">
        <div className="space-y-2">
          <Input
            autoFocus
            size="sm"
            type="search"
            placeholder="Search agents"
            aria-label="Search agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="px-1 text-xs font-medium text-muted-foreground">Agents</div>
          {matches.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {props.agents.length === 0 ? "No agents in this space yet." : "No matching agents."}
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {matches.map((agent) => (
                <li key={agent.id}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => {
                      setOpen(false);
                      props.onOpen(agent);
                    }}
                  >
                    <ThreadStatusDot thread={agent} />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {spaceThreadTitle(agent)}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {compactAge(agent.updatedAt ?? agent.createdAt)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {props.onNewAgent ? (
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                props.onNewAgent?.();
              }}
            >
              <PlusIcon />
              New agent
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function SpaceMenu({ space }: { readonly space: Space }) {
  const archive = useArchiveSpace();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={`${space.name} actions`} />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => openSpaceSettings(space.id)}>
          <SettingsIcon />
          Space settings…
        </MenuItem>
        <MenuItem variant="destructive" onClick={() => void archive(space)}>
          <ArchiveIcon />
          Archive space…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
