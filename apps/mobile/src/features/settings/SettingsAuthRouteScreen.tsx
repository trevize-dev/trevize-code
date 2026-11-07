import type { TrevizeDeviceSignIn } from "@t3tools/client-runtime/trevize";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { useAtomCommand } from "../../state/use-atom-command";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";
import * as Trevize from "../cloud/trevize";
import { trevizeAccountSource, useAuth } from "../cloud/trevizeAccount";

// Trevize: T3 Connect signs in with a Trevize account. Clerk's native sign-in and
// profile views are replaced by a device sign-in and the T3 Connect page.

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth();
  const signOut = useAtomCommand(Trevize.signOut);

  if (!isLoaded) return <View collapsable={false} className="flex-1 bg-clerk-page" />;
  if (!isSignedIn) return <TrevizeSignIn />;

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-clerk-page">
      <T3ConnectProfilePage />
      <View className="border-t border-clerk-border px-6 py-4">
        <Button
          label="Sign out of Trevize"
          tone="danger"
          fullWidth
          onPress={() => {
            void signOut().then(() => trevizeAccountSource.refresh());
          }}
        />
      </View>
    </View>
  );
}

function TrevizeSignIn() {
  const startDeviceSignIn = useAtomCommand(Trevize.startDeviceSignIn, { reportFailure: false });
  const completeDeviceSignIn = useAtomCommand(Trevize.completeDeviceSignIn, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<TrevizeDeviceSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops polling for approval when the screen goes away
  useEffect(() => () => abort.current?.abort(), []);

  const begin = async () => {
    setError(null);
    const started = await startDeviceSignIn();
    if (started._tag !== "Success") {
      setError("Could not reach Trevize. Check your connection and try again.");
      return;
    }
    const signIn = started.value;
    setPending(signIn);
    void Linking.openURL(signIn.verificationUrl).catch(() => undefined);
    const controller = new AbortController();
    abort.current = controller;
    const completed = await completeDeviceSignIn({ signIn, signal: controller.signal });
    if (controller.signal.aborted) return;
    setPending(null);
    if (completed._tag === "Success") trevizeAccountSource.refresh();
    else setError("Sign-in did not finish. Try again.");
  };

  return (
    <View collapsable={false} className="flex-1 gap-4 bg-clerk-page px-6 py-8">
      <Text className="text-lg font-semibold text-clerk-foreground">Sign in with Trevize</Text>
      <Text className="text-base text-clerk-foreground-muted">
        T3 Connect uses your Trevize account to reach your environments from anywhere.
      </Text>
      {pending ? (
        <>
          <Text className="text-base text-clerk-foreground-muted">
            Approve this code in your browser:
          </Text>
          <Text selectable className="text-2xl font-semibold tracking-widest text-clerk-foreground">
            {pending.userCode}
          </Text>
          <Button
            label="Open Trevize"
            fullWidth
            onPress={() => void Linking.openURL(pending.verificationUrl).catch(() => undefined)}
          />
          <Button
            label="Cancel"
            tone="text"
            fullWidth
            onPress={() => {
              abort.current?.abort();
              setPending(null);
            }}
          />
        </>
      ) : (
        <Button label="Sign in" tone="primary" fullWidth onPress={() => void begin()} />
      )}
      {error ? <Text className="text-sm text-danger">{error}</Text> : null}
    </View>
  );
}
