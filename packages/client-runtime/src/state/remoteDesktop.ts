import { WS_METHODS } from "@t3tools/contracts";
import type { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { resolveRemoteDesktopUrl } from "./desktopUrl.ts";
import { createEnvironmentRpcCommand, createRuntimeCommand } from "./runtime.ts";

export function createRemoteDesktopEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop:prepare",
      tag: WS_METHODS.desktopPrepare,
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
    }),
    resolveUrl: createRuntimeCommand(runtime, {
      label: "environment-data:desktop:resolve-url",
      execute: (prepared: PreparedConnection) => resolveRemoteDesktopUrl(prepared),
    }),
  };
}
