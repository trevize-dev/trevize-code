import { createRemoteDesktopEnvironmentAtoms } from "@t3tools/client-runtime/state/remoteDesktop";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteDesktopEnvironment = createRemoteDesktopEnvironmentAtoms(connectionAtomRuntime);
