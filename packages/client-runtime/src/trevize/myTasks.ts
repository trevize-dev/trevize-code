import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { TrevizeEnvironment, TrevizeThread } from "./api.ts";
import { findSavedTrevizeEnvironment } from "./connect.ts";

/**
 * "My tasks": Trevize-launched threads assigned to the signed-in Trevize user,
 * across all of their workspaces. Loaded by the Trevize Cloud sync loop.
 */

export type MyTaskStatus = "running" | "waiting" | "done" | "failed" | "sleeping" | "starting";

export const MY_TASK_STATUS_LABELS: Record<MyTaskStatus, string> = {
  running: "Running",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
  sleeping: "Sleeping",
  starting: "Starting",
};

const THREAD_STATUSES: Record<string, MyTaskStatus> = {
  running: "running",
  working: "running",
  in_progress: "running",
  waiting: "waiting",
  needs_input: "waiting",
  awaiting_input: "waiting",
  done: "done",
  completed: "done",
  idle: "done",
  failed: "failed",
  error: "failed",
  errored: "failed",
};

/**
 * The status a task row shows, or null when nothing is known. A request for
 * the user wins over everything (it survives the sandbox sleeping), then a
 * finished thread, then the environment's own state, then the thread's.
 */
export function deriveMyTaskStatus(task: TrevizeThread): MyTaskStatus | null {
  const threadStatus = task.status ? (THREAD_STATUSES[task.status.toLowerCase()] ?? null) : null;
  // A pending request is an object (or `true`); `false` means there is none.
  const request = task.pendingRuntimeRequest;
  const pendingRequest = request === true || (typeof request === "object" && request !== null);
  if (task.waiting === true || pendingRequest || threadStatus === "waiting") return "waiting";
  if (threadStatus === "failed" || threadStatus === "done") return threadStatus;
  switch (task.environmentStatus) {
    case "stopped":
      return "sleeping";
    case "failed":
      return "failed";
    case "provisioning":
    case "starting":
      return "starting";
  }
  return threadStatus;
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  api: "API",
  linear: "Linear",
  automation: "Automation",
  orchestrator: "Orchestrator",
  manual: "Manual",
};

/** The source badge text: the external reference (e.g. `LIN-123`) or the kind. */
export function myTaskSourceLabel(task: Pick<TrevizeThread, "sourceKind" | "sourceRef">): string {
  const ref = task.sourceRef?.trim();
  if (ref) return ref;
  return (
    SOURCE_KIND_LABELS[task.sourceKind] ??
    task.sourceKind.charAt(0).toUpperCase() + task.sourceKind.slice(1)
  );
}

export function myTaskActivityAt(task: TrevizeThread): string {
  return task.updatedAt ?? task.createdAt;
}

/** Merges per-workspace listings: one row per task, most recent activity first. */
export function mergeMyTasks(
  listings: ReadonlyArray<ReadonlyArray<TrevizeThread>>,
): ReadonlyArray<TrevizeThread> {
  const byId = new Map<string, TrevizeThread>();
  for (const listing of listings) {
    for (const task of listing) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => myTaskActivityAt(b).localeCompare(myTaskActivityAt(a)));
}

const isThreadId = Schema.is(ThreadId);

export type MyTaskTarget =
  /** Saved on this device: open `/<environmentId>/<threadId>`, waking it first when sleeping. */
  | {
      readonly _tag: "Saved";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly sleeping: boolean;
    }
  /** Not saved on this device: connect it through Trevize, then open the thread. */
  | {
      readonly _tag: "Connect";
      readonly environment: TrevizeEnvironment;
      readonly threadId: ThreadId;
    }
  | { readonly _tag: "Unavailable"; readonly reason: string };

/**
 * Where opening a task leads. The route's environment id is the T3 server's,
 * which only the saved environment knows; it is found by the Trevize
 * environment's gateway origin like the rest of Trevize sync.
 */
export function resolveMyTaskTarget(
  task: Pick<TrevizeThread, "environmentId" | "t3ThreadId">,
  environments: ReadonlyArray<TrevizeEnvironment>,
  saved: Iterable<ConnectionCatalogEntry>,
): MyTaskTarget {
  const environment = environments.find((candidate) => candidate.id === task.environmentId);
  if (environment === undefined || environment.status === "archived") {
    return {
      _tag: "Unavailable",
      reason: "Trevize no longer lists this task's environment.",
    };
  }
  const threadId = task.t3ThreadId;
  if (!isThreadId(threadId)) {
    return { _tag: "Unavailable", reason: "Trevize sent an invalid thread id." };
  }
  const environmentId = findSavedTrevizeEnvironment(saved, environment.httpBaseUrl);
  if (environmentId === null) return { _tag: "Connect", environment, threadId };
  return {
    _tag: "Saved",
    environmentId,
    threadId,
    sleeping: environment.status === "stopped",
  };
}
