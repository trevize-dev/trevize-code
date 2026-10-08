import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  TrevizeApi,
  clearTrevizeApiKey,
  connectTrevizeEnvironment,
  loadTrevizeApiKey,
  saveTrevizeApiKey,
} from "@t3tools/client-runtime/trevize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";

/** Non-secret Trevize settings, kept per client in local storage. The API key is not here. */
export const TrevizeClientSettings = Schema.Struct({
  baseUrl: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
});
export type TrevizeClientSettings = typeof TrevizeClientSettings.Type;

export const TREVIZE_SETTINGS_STORAGE_KEY = "t3code:trevize:v1";

export function defaultTrevizeBaseUrl(): string {
  return import.meta.env.VITE_TREVIZE_API_URL?.trim() || TrevizeApi.DEFAULT_TREVIZE_API_URL;
}

export const loadApiKey = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:load-api-key",
  execute: (_input: void) => loadTrevizeApiKey(),
});

/** Checks the key against Trevize before storing it, and returns the workspaces it can see. */
export const signIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:sign-in",
  execute: (config: TrevizeApi.TrevizeApiConfig) =>
    TrevizeApi.listWorkspaces(config).pipe(Effect.tap(() => saveTrevizeApiKey(config.apiKey))),
});

export const signOut = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:trevize:sign-out",
  execute: (_input: void) => clearTrevizeApiKey(),
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
