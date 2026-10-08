import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import type { TrevizeEnvironment, TrevizeThread } from "./api.ts";
import {
  deriveMyTaskStatus,
  mergeMyTasks,
  myTaskSourceLabel,
  resolveMyTaskTarget,
} from "./myTasks.ts";

function task(overrides: Partial<TrevizeThread> = {}): TrevizeThread {
  return {
    id: "thr_1",
    environmentId: "env_a",
    t3ThreadId: "t3-thread-1",
    sourceKind: "linear",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function environment(id: string, status: TrevizeEnvironment["status"]): TrevizeEnvironment {
  return {
    id,
    workspaceId: "ws_1",
    title: id,
    status,
    repositoryIds: [],
    httpBaseUrl: `https://t3-${id}.gw.example.test`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function savedEntry(environmentId: EnvironmentId, httpBaseUrl: string): ConnectionCatalogEntry {
  const connectionId = `bearer:${environmentId}`;
  return {
    target: new BearerConnectionTarget({
      environmentId,
      label: environmentId,
      connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: environmentId,
        httpBaseUrl: `${httpBaseUrl}/`,
        wsBaseUrl: httpBaseUrl.replace("https:", "wss:"),
      }),
    ),
    enabled: true,
  };
}

describe("deriveMyTaskStatus", () => {
  it("knows nothing without thread or environment state", () => {
    expect(deriveMyTaskStatus(task())).toBeNull();
    expect(deriveMyTaskStatus(task({ environmentStatus: "running" }))).toBeNull();
  });

  it("maps thread statuses tolerantly", () => {
    expect(deriveMyTaskStatus(task({ status: "running" }))).toBe("running");
    expect(deriveMyTaskStatus(task({ status: "Completed" }))).toBe("done");
    expect(deriveMyTaskStatus(task({ status: "error" }))).toBe("failed");
    expect(deriveMyTaskStatus(task({ status: "something-new" }))).toBeNull();
  });

  it("shows a request for the user first, even while the environment sleeps", () => {
    expect(deriveMyTaskStatus(task({ waiting: true, environmentStatus: "stopped" }))).toBe(
      "waiting",
    );
    expect(deriveMyTaskStatus(task({ pendingRuntimeRequest: { kind: "approval" } }))).toBe(
      "waiting",
    );
    expect(deriveMyTaskStatus(task({ pendingRuntimeRequest: null, status: "running" }))).toBe(
      "running",
    );
  });

  it("keeps a finished thread's outcome over its sleeping environment", () => {
    expect(deriveMyTaskStatus(task({ status: "done", environmentStatus: "stopped" }))).toBe("done");
    expect(deriveMyTaskStatus(task({ status: "running", environmentStatus: "stopped" }))).toBe(
      "sleeping",
    );
    expect(deriveMyTaskStatus(task({ environmentStatus: "starting" }))).toBe("starting");
    expect(deriveMyTaskStatus(task({ environmentStatus: "failed" }))).toBe("failed");
  });
});

describe("myTaskSourceLabel", () => {
  it("prefers the external reference and falls back to the kind", () => {
    expect(myTaskSourceLabel({ sourceKind: "linear", sourceRef: "LIN-123" })).toBe("LIN-123");
    expect(myTaskSourceLabel({ sourceKind: "linear", sourceRef: " " })).toBe("Linear");
    expect(myTaskSourceLabel({ sourceKind: "api", sourceRef: null })).toBe("API");
    expect(myTaskSourceLabel({ sourceKind: "webhook" })).toBe("Webhook");
  });
});

describe("mergeMyTasks", () => {
  it("dedupes across workspaces and orders by latest activity", () => {
    const older = task({ id: "a", createdAt: "2026-10-01T00:00:00.000Z" });
    const updated = task({
      id: "b",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    const newer = task({ id: "c", createdAt: "2026-10-02T00:00:00.000Z" });
    expect(
      mergeMyTasks([
        [older, newer],
        [updated, older],
      ]).map((t) => t.id),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("resolveMyTaskTarget", () => {
  const T3_A = EnvironmentId.make("t3-a");
  const saved = [savedEntry(T3_A, "https://t3-env_a.gw.example.test")];
  const threadId = ThreadId.make("t3-thread-1");

  it("routes to the saved environment's T3 id, not Trevize's", () => {
    expect(resolveMyTaskTarget(task(), [environment("env_a", "running")], saved)).toEqual({
      _tag: "Saved",
      environmentId: T3_A,
      threadId,
      sleeping: false,
    });
  });

  it("wakes a saved environment that sleeps", () => {
    expect(resolveMyTaskTarget(task(), [environment("env_a", "stopped")], saved)).toMatchObject({
      _tag: "Saved",
      sleeping: true,
    });
  });

  it("connects an environment this device has not saved", () => {
    const unsaved = environment("env_b", "stopped");
    expect(resolveMyTaskTarget(task({ environmentId: "env_b" }), [unsaved], saved)).toEqual({
      _tag: "Connect",
      environment: unsaved,
      threadId,
    });
  });

  it("refuses unknown or archived environments and invalid thread ids", () => {
    expect(resolveMyTaskTarget(task(), [], saved)._tag).toBe("Unavailable");
    expect(resolveMyTaskTarget(task(), [environment("env_a", "archived")], saved)._tag).toBe(
      "Unavailable",
    );
    expect(
      resolveMyTaskTarget(task({ t3ThreadId: " " }), [environment("env_a", "running")], saved)._tag,
    ).toBe("Unavailable");
  });
});
