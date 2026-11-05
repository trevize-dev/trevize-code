import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  TrevizeApi,
  clearTrevizeApiKey,
  connectTrevizeEnvironment,
  loadTrevizeApiKey,
  saveTrevizeApiKey,
  TrevizeSync,
  awaitTrevizeDeviceSignIn,
  revokeTrevizeSession,
  startTrevizeDeviceSignIn,
  type TrevizeDeviceSignIn,
} from "@t3tools/client-runtime/trevize";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

import { updateStoredTrevizeSettings } from "./settingsStore";

export {
  TREVIZE_SETTINGS_STORAGE_KEY,
  defaultTrevizeBaseUrl,
  defaultTrevizeSettings,
} from "./settingsStore";
export const TrevizeClientSettings = TrevizeSync.TrevizeClientSettings;
export type TrevizeClientSettings = TrevizeSync.TrevizeClientSettings;

const requestSync = TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.syncNow));

const syncStateAtom = connectionAtomRuntime.atom(
  Stream.unwrap(
    TrevizeSync.TrevizeCloudSync.pipe(Effect.map((sync) => SubscriptionRef.changes(sync.state))),
  ),
  { initialValue: TrevizeSync.EMPTY_TREVIZE_CLOUD_SYNC_STATE },
);
/** What the Trevize Cloud sync last saw, including which saved environments sleep. */
export const syncStateValueAtom = Atom.make((get) =>
  Option.getOrElse(
    AsyncResult.value(get(syncStateAtom)),
    () => TrevizeSync.EMPTY_TREVIZE_CLOUD_SYNC_STATE,
  ),
).pipe(Atom.withLabel("trevize-cloud-sync-state"));

export const syncNow = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:sync-now",
  execute: (_input: void) => requestSync,
});

/** Wakes a sleeping Trevize environment and reconnects it. */
export const wakeEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:wake-environment",
  concurrency: {
    mode: "singleFlight",
    key: (environmentId: EnvironmentId) => environmentId,
  },
  execute: (environmentId: EnvironmentId) =>
    TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.wake(environmentId))),
});

export const loadApiKey = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:load-api-key",
  execute: (_input: void) => loadTrevizeApiKey(),
});

/** Checks a credential against Trevize, stores it, and returns the workspaces it can see. */
const signInWith = (config: TrevizeApi.TrevizeApiConfig) =>
  TrevizeApi.listWorkspaces(config).pipe(
    Effect.tap(() => saveTrevizeApiKey(config.apiKey)),
    // The first sync must already use the URL just signed in to.
    Effect.tap(() =>
      Effect.sync(() =>
        updateStoredTrevizeSettings((current) => ({ ...current, baseUrl: config.baseUrl })),
      ),
    ),
    Effect.tap(() => requestSync),
  );

/** Signs in with a pasted API key. */
export const signIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:sign-in",
  execute: signInWith,
});

/** Asks Trevize for a code the user approves in their browser. */
export const startDeviceSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:start-device-sign-in",
  execute: (baseUrl: string) => startTrevizeDeviceSignIn(baseUrl),
});

/** Ends with an interrupt when `signal` aborts, e.g. on Cancel or unmount. */
const abortedBy = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

/** Waits for the user to approve the code, then signs in with the session it grants. */
export const completeDeviceSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:complete-device-sign-in",
  execute: (input: { readonly signIn: TrevizeDeviceSignIn; readonly signal: AbortSignal }) =>
    awaitTrevizeDeviceSignIn(input.signIn).pipe(
      Effect.raceFirst(abortedBy(input.signal)),
      Effect.map((token) => ({ baseUrl: input.signIn.baseUrl, apiKey: token })),
      Effect.flatMap((config) =>
        signInWith(config).pipe(Effect.map((workspaces) => ({ config, workspaces }))),
      ),
    ),
});

/** Forgets the credential, and ends the Trevize session when it came from a device sign-in. */
export const signOut = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:sign-out",
  execute: (config: TrevizeApi.TrevizeApiConfig) =>
    revokeTrevizeSession(config.baseUrl, config.apiKey).pipe(
      Effect.andThen(clearTrevizeApiKey()),
      Effect.tap(() => requestSync),
    ),
});

export const listWorkspaces = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:list-workspaces",
  execute: (config: TrevizeApi.TrevizeApiConfig) => TrevizeApi.listWorkspaces(config),
});

export const listEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:list-environments",
  execute: (input: {
    readonly config: TrevizeApi.TrevizeApiConfig;
    readonly workspaceId: string;
  }) => TrevizeApi.listEnvironments(input.config, input.workspaceId),
});

export const listRepositories = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:list-repositories",
  execute: (input: {
    readonly config: TrevizeApi.TrevizeApiConfig;
    readonly workspaceId: string;
  }) => TrevizeApi.listRepositories(input.config, input.workspaceId),
});

export const createEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:create-environment",
  execute: (input: {
    readonly config: TrevizeApi.TrevizeApiConfig;
    readonly workspaceId: string;
    readonly repositoryIds: ReadonlyArray<string>;
    readonly title: string;
  }) => TrevizeApi.createEnvironment(input.config, input),
});

export const stopEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:stop-environment",
  execute: (input: {
    readonly config: TrevizeApi.TrevizeApiConfig;
    readonly environmentId: string;
  }) => TrevizeApi.stopEnvironment(input.config, input.environmentId),
});

export const connectEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:connect-environment",
  concurrency: {
    mode: "singleFlight",
    key: (input: {
      readonly config: TrevizeApi.TrevizeApiConfig;
      readonly environment: TrevizeApi.TrevizeEnvironment;
    }) => input.environment.id,
  },
  execute: (input) => connectTrevizeEnvironment(input),
});

/** Makes a "My tasks" thread openable (waking or connecting its environment) and returns its route. */
export const openTask = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:open-task",
  concurrency: {
    mode: "singleFlight",
    key: (task: Pick<TrevizeApi.TrevizeThread, "id" | "environmentId" | "runtimeThreadId">) =>
      task.id,
  },
  execute: (task) =>
    TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.openTask(task))),
});

/** Creates a space; Trevize launches its orchestrator in the background. */
export const createSpace = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:create-space",
  execute: (input: TrevizeSync.CreateSpaceInput) =>
    TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.createSpace(input))),
});

/** Saves a space's name, icon, color, instructions or sandbox limit. */
export const updateSpace = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:update-space",
  execute: (input: { readonly spaceId: string; readonly patch: TrevizeApi.TrevizeSpacePatch }) =>
    TrevizeSync.TrevizeCloudSync.pipe(
      Effect.flatMap((sync) => sync.updateSpace(input.spaceId, input.patch)),
    ),
});

export const archiveSpace = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:archive-space",
  execute: (spaceId: string) =>
    TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.archiveSpace(spaceId))),
});

/** Starts a cloud session; resolves with the new thread's route once it runs. */
export const launchSession = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:launch-session",
  execute: (input: TrevizeSync.LaunchSessionInput) =>
    TrevizeSync.TrevizeCloudSync.pipe(Effect.flatMap((sync) => sync.launchSession(input))),
});
