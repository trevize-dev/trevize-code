import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type RemoteDesktopErrorReason } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ControlPill } from "../../components/ui/ControlPill";
import { EmptyState } from "../../components/ui/EmptyState";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useContentTopInset } from "../../components/ui/useBarInset";
import type { MessageResolver } from "../../i18n/messages";
import { useAppForeground } from "../../lib/appState";
import { remoteDesktopEnvironment } from "../../state/remoteDesktop";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type DesktopPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type DesktopState =
  | { readonly phase: "preparing" }
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

export function DesktopPreviewRouteScreen({ route }: DesktopPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId } = route.params;
  if (!environmentId?.trim()) {
    return <DesktopUnavailableScreen onClose={onClose} />;
  }
  return (
    <DesktopPreviewScreen environmentId={EnvironmentId.make(environmentId)} onClose={onClose} />
  );
}

function DesktopUnavailableScreen({ onClose }: { readonly onClose: () => void }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: contentTopInset, paddingBottom: insets.bottom }}
    >
      <SheetHeader
        title={gt("Desktop", { $context: "screen title" })}
        onClose={onClose}
        accessibilityLabel={gt("Close desktop")}
      />
    </View>
  );
}

function DesktopPreviewScreen({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const { themeVariables } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = Option.getOrNull(preparedOption);
  const prepareDesktop = useAtomCommand(remoteDesktopEnvironment.prepare, {
    reportFailure: false,
  });
  const resolveDesktopUrl = useAtomCommand(remoteDesktopEnvironment.resolveUrl, {
    reportFailure: false,
  });

  const [reconnectToken, setReconnectToken] = useState(0);
  const requestKey = `${environmentId}:${reconnectToken}`;
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: Exclude<DesktopState, { readonly phase: "preparing" }>;
  } | null>(null);
  const [controllingKey, setControllingKey] = useState<string | null>(null);

  const live = focused && foreground;
  const state: DesktopState =
    settled !== null && settled.key === requestKey ? settled.state : { phase: "preparing" };
  const controlling = live && state.phase === "ready" && controllingKey === requestKey;

  const connect = useEffectEvent(
    async (
      activeEnvironmentId: EnvironmentId,
      activePrepared: PreparedConnection,
      activeKey: string,
      connectionKey: number,
      signal: AbortSignal,
    ): Promise<{
      readonly key: string;
      readonly state: Exclude<DesktopState, { readonly phase: "preparing" }>;
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
            message: remoteDesktopErrorMessage(
              squashAtomCommandFailure(preparedResult),
              resolveMessage,
            ),
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
            message: remoteDesktopErrorMessage(squashAtomCommandFailure(urlResult), resolveMessage),
          },
        };
      }

      return {
        key: activeKey,
        state: {
          phase: "ready",
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

  const handleReconnect = () => {
    setControllingKey(null);
    setReconnectToken((value) => value + 1);
  };

  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={{
        flex: 1,
        backgroundColor: themeVariables["--color-sheet-solid"],
        paddingBottom: insets.bottom,
      }}
    >
      <View className="flex-row items-center justify-between gap-2 px-3 py-2">
        <ControlPill icon="xmark" accessibilityLabel={gt("Close desktop")} onPress={onClose} />
        <View className="flex-row items-center gap-2">
          {state.phase === "ready" ? (
            <ControlPill
              variant={controlling ? "primary" : "pill"}
              label={controlling ? gt("Stop controlling") : gt("Take control")}
              onPress={() =>
                setControllingKey((current) => (current === requestKey ? null : requestKey))
              }
            />
          ) : null}
          <ControlPill
            icon="arrow.clockwise"
            accessibilityLabel={gt("Reconnect")}
            disabled={state.phase === "preparing"}
            onPress={handleReconnect}
          />
        </View>
      </View>

      <View className="flex-1 bg-black">
        {state.phase === "ready" ? (
          live ? (
            <View className="flex-1" pointerEvents={controlling ? "auto" : "none"}>
              <WebView
                key={state.connectionKey}
                source={{ uri: state.url }}
                javaScriptEnabled
                domStorageEnabled
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                startInLoadingState
                renderLoading={() => (
                  <View
                    className="absolute inset-0 items-center justify-center"
                    style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}
                  >
                    <AppActivityIndicator color={themeVariables["--color-icon"]} />
                  </View>
                )}
                onError={(event) => {
                  setSettled({
                    key: requestKey,
                    state: {
                      phase: "error",
                      message:
                        event.nativeEvent.description ||
                        resolveMessage(msg("Couldn't connect to the remote desktop.")),
                    },
                  });
                }}
                onHttpError={(event) => {
                  if (event.nativeEvent.statusCode >= 400) {
                    setSettled({
                      key: requestKey,
                      state: {
                        phase: "error",
                        message: resolveMessage(msg("Couldn't connect to the remote desktop.")),
                      },
                    });
                  }
                }}
                style={{ flex: 1, backgroundColor: "black" }}
              />
            </View>
          ) : (
            <View className="flex-1" />
          )
        ) : state.phase === "preparing" ? (
          <View
            className="flex-1 items-center justify-center"
            style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}
          >
            {live ? <AppActivityIndicator color={themeVariables["--color-icon"]} /> : null}
          </View>
        ) : (
          <View
            className="flex-1 items-center justify-center"
            style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}
          >
            <View className="w-full max-w-md">
              <EmptyState
                variant="plain"
                title={gt("Desktop unavailable")}
                detail={state.message}
                actionLabel={gt("Reconnect")}
                onAction={handleReconnect}
              />
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
