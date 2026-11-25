import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RemoteDesktopErrorReason } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages } from "gt-react";
import { HandIcon, HandMetalIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { remoteDesktopEnvironment } from "~/state/remoteDesktop";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const DESKTOP_FRAME_LOAD_TIMEOUT_MS = 15_000;

type DesktopPanelState =
  | { readonly phase: "preparing" }
  | { readonly phase: "loading"; readonly url: string; readonly connectionKey: number }
  | { readonly phase: "ready"; readonly url: string; readonly connectionKey: number }
  | { readonly phase: "error"; readonly message: string };

function remoteDesktopErrorMessage(error: unknown, resolve: MessageResolver): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "RemoteDesktopError" &&
    "reason" in error
  ) {
    switch (error.reason as RemoteDesktopErrorReason) {
      case "not_configured":
        return resolve(msg("Remote desktop isn't configured on this environment."));
      case "start_failed":
        return resolve(msg("Couldn't start the remote desktop."));
      case "not_ready":
        return resolve(msg("The remote desktop didn't become ready in time."));
    }
  }
  return (
    errorDisplayMessage(error, resolve) ?? resolve(msg("Couldn't connect to the remote desktop."))
  );
}

export function DesktopPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
}) {
  const { environmentId, visible } = props;
  const gt = useGT();
  const messages = useMessages();
  const prepareDesktop = useAtomCommand(remoteDesktopEnvironment.prepare, {
    reportFailure: false,
  });
  const resolveDesktopUrl = useAtomCommand(remoteDesktopEnvironment.resolveUrl, {
    reportFailure: false,
  });
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);

  const [reconnectToken, setReconnectToken] = useState(0);
  const requestKey = `${environmentId}:${reconnectToken}`;
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: Exclude<DesktopPanelState, { readonly phase: "preparing" }>;
  } | null>(null);
  const [controllingKey, setControllingKey] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const state: DesktopPanelState =
    settled !== null && settled.key === requestKey ? settled.state : { phase: "preparing" };
  const controlling = visible && state.phase === "ready" && controllingKey === requestKey;

  const connect = useEffectEvent(
    async (
      activeEnvironmentId: EnvironmentId,
      activePrepared: PreparedConnection,
      activeKey: string,
      connectionKey: number,
      signal: AbortSignal,
    ): Promise<{
      readonly key: string;
      readonly state: Exclude<DesktopPanelState, { readonly phase: "preparing" }>;
    } | null> => {
      const preparedResult = await prepareDesktop(
        { environmentId: activeEnvironmentId, input: {} },
        { signal },
      );
      if (signal.aborted) return null;
      if (preparedResult._tag === "Failure") {
        if (isAtomCommandInterrupted(preparedResult)) return null;
        return {
          key: activeKey,
          state: {
            phase: "error",
            message: remoteDesktopErrorMessage(squashAtomCommandFailure(preparedResult), messages),
          },
        };
      }

      const urlResult = await resolveDesktopUrl(activePrepared, { signal });
      if (signal.aborted) return null;
      if (urlResult._tag === "Failure") {
        if (isAtomCommandInterrupted(urlResult)) return null;
        return {
          key: activeKey,
          state: {
            phase: "error",
            message: remoteDesktopErrorMessage(squashAtomCommandFailure(urlResult), messages),
          },
        };
      }

      return {
        key: activeKey,
        state: {
          phase: "loading",
          url: urlResult.value,
          connectionKey,
        },
      };
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prepares the remote desktop on the environment server and mints a fresh viewer URL on mount or reconnect
  useEffect(() => {
    if (prepared === null) return;
    const controller = new AbortController();
    void connect(environmentId, prepared, requestKey, reconnectToken + 1, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted && next !== null) {
          setSettled(next);
        }
      },
    );
    return () => controller.abort();
  }, [environmentId, prepared, requestKey, reconnectToken]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fails closed if the remote desktop iframe does not fire load within 15 seconds
  useEffect(() => {
    if (state.phase !== "loading") return;
    const activeKey = requestKey;
    const activeConnectionKey = state.connectionKey;
    const timer = window.setTimeout(() => {
      setSettled((current) =>
        current !== null &&
        current.key === activeKey &&
        current.state.phase === "loading" &&
        current.state.connectionKey === activeConnectionKey
          ? {
              key: activeKey,
              state: {
                phase: "error",
                message: messages(msg("Timed out while loading the remote desktop.")),
              },
            }
          : current,
      );
    }, DESKTOP_FRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state, requestKey, messages]);

  const handleReconnect = () => {
    setControllingKey(null);
    setReconnectToken((value) => value + 1);
  };

  const handleTakeControl = () => {
    setControllingKey(requestKey);
    requestAnimationFrame(() => {
      iframeRef.current?.focus();
    });
  };

  const handleStopControlling = () => {
    setControllingKey(null);
    if (document.activeElement === iframeRef.current) {
      iframeRef.current?.blur();
    }
  };

  const hasFrame = state.phase === "loading" || state.phase === "ready";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <MonitorIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {state.phase === "ready" ? (
              controlling ? (
                <T>Controlling</T>
              ) : (
                <T>View only</T>
              )
            ) : state.phase === "error" ? (
              <T>Disconnected</T>
            ) : (
              <T>Connecting…</T>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state.phase === "ready" ? (
            controlling ? (
              <Button size="xs" variant="secondary" onClick={handleStopControlling}>
                <HandIcon />
                <T>Stop controlling</T>
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={handleTakeControl}>
                <HandMetalIcon />
                <T>Take control</T>
              </Button>
            )
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={state.phase === "preparing"}
            onClick={handleReconnect}
          >
            <RefreshCwIcon />
            <T>Reconnect</T>
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasFrame ? (
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
            <div className="size-full" inert={!controlling}>
              {/* oxlint-disable-next-line react/iframe-missing-sandbox -- voxl serves its own viewer from the environment origin and needs WebCodecs, workers, and clipboard */}
              <iframe
                ref={iframeRef}
                key={state.connectionKey}
                src={state.url}
                title={gt("Remote desktop")}
                tabIndex={controlling ? 0 : -1}
                allow="clipboard-read; clipboard-write; fullscreen"
                referrerPolicy="no-referrer"
                onLoad={() => {
                  setSettled((current) =>
                    current !== null &&
                    current.key === requestKey &&
                    current.state.phase === "loading" &&
                    current.state.connectionKey === state.connectionKey
                      ? {
                          key: current.key,
                          state: {
                            phase: "ready",
                            url: current.state.url,
                            connectionKey: current.state.connectionKey,
                          },
                        }
                      : current,
                  );
                }}
                className={cn("block size-full border-0", !controlling && "pointer-events-none")}
              />
            </div>
            {state.phase === "loading" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80">
                <Spinner />
                <p className="text-muted-foreground text-xs">
                  <T>Loading remote desktop…</T>
                </p>
              </div>
            ) : null}
          </div>
        ) : state.phase === "preparing" ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
            <Spinner />
            <p className="text-muted-foreground text-xs">
              <T>Starting remote desktop…</T>
            </p>
          </div>
        ) : (
          <Empty>
            <EmptyMedia variant="icon">
              <MonitorIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                <T>Desktop unavailable</T>
              </EmptyTitle>
              <EmptyDescription>{state.message}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" variant="outline" onClick={handleReconnect}>
                <RefreshCwIcon />
                <T>Reconnect</T>
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
  );
}
