import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import type { TrevizeEnvironment } from "./api.ts";
import * as TrevizeSync from "./sync.ts";

function trevizeEnvironment(
  id: string,
  status: TrevizeEnvironment["status"],
  workspaceId = "ws_1",
): TrevizeEnvironment {
  return {
    id,
    workspaceId,
    title: id,
    status,
    repositoryIds: [],
    httpBaseUrl: `https://env-${id}.gw.example.test`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: null,
    error: null,
  };
}

function origin(id: string) {
  return `https://env-${id}.gw.example.test`;
}

function savedEntry(environmentId: EnvironmentId, httpBaseUrl: string): ConnectionCatalogEntry {
  const connectionId = `bearer:${environmentId}:${httpBaseUrl}`;
  return {
    target: new BearerConnectionTarget({ environmentId, label: environmentId, connectionId }),
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

const T3_A = EnvironmentId.make("t3-a");
const T3_B = EnvironmentId.make("t3-b");
const T3_MANUAL = EnvironmentId.make("t3-manual");

const decodeSettingsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(TrevizeSync.TrevizeClientSettings),
);

describe("TrevizeClientSettings", () => {
  it("defaults settings saved before sync existed", () => {
    expect(
      decodeSettingsJson(
        JSON.stringify({ baseUrl: "https://trevize.example.test", workspaceId: null }),
      ),
    ).toEqual({
      baseUrl: "https://trevize.example.test",
      workspaceId: null,
      autoConnect: true,
      managedOrigins: [],
    });
  });
});

describe("planTrevizeSync", () => {
  const plan = (input: Partial<TrevizeSync.TrevizeSyncInput>) =>
    TrevizeSync.planTrevizeSync({
      environments: [],
      saved: [],
      managedOrigins: [],
      autoConnect: true,
      rejectedCredentials: new Set(),
      ...input,
    });

  it("pairs only unsaved running environments", () => {
    const running = trevizeEnvironment("env_run", "running");
    const stopped = trevizeEnvironment("env_stop", "stopped");
    const starting = trevizeEnvironment("env_start", "starting", "ws_2");
    const result = plan({ environments: [running, stopped, starting] });

    expect(result.actions).toEqual([
      { _tag: "Pair", environment: running },
      { _tag: "Noop", environmentId: null, environment: stopped },
      { _tag: "Noop", environmentId: null, environment: starting },
    ]);
    expect(result.managedOrigins).toEqual([
      origin("env_run"),
      origin("env_start"),
      origin("env_stop"),
    ]);
  });

  it("leaves a saved environment alone unless its credential was rejected", () => {
    const a = trevizeEnvironment("env_a", "running");
    const b = trevizeEnvironment("env_b", "running");
    const saved = [savedEntry(T3_A, origin("env_a")), savedEntry(T3_B, origin("env_b"))];

    expect(
      plan({ environments: [a, b], saved, rejectedCredentials: new Set([T3_B]) }).actions,
    ).toEqual([
      { _tag: "Noop", environmentId: T3_A, environment: a },
      { _tag: "Pair", environment: b },
    ]);
  });

  it("does not pair when automatic connection is off", () => {
    const running = trevizeEnvironment("env_run", "running");
    expect(plan({ environments: [running], autoConnect: false }).actions).toEqual([
      { _tag: "Noop", environmentId: null, environment: running },
    ]);
  });

  it("marks saved stopped environments as sleeping", () => {
    const stopped = trevizeEnvironment("env_a", "stopped");
    expect(
      plan({ environments: [stopped], saved: [savedEntry(T3_A, origin("env_a"))] }).actions,
    ).toEqual([{ _tag: "MarkSleeping", environmentId: T3_A, environment: stopped }]);
  });

  it("removes archived and vanished Trevize environments but never manual pairings", () => {
    const archived = trevizeEnvironment("env_a", "archived");
    const result = plan({
      environments: [archived],
      saved: [
        savedEntry(T3_A, origin("env_a")),
        savedEntry(T3_B, origin("env_gone")),
        savedEntry(T3_MANUAL, "https://my-laptop.example.test"),
      ],
      managedOrigins: [origin("env_gone"), origin("env_never_saved")],
    });

    expect(result.actions).toEqual([
      { _tag: "Remove", environmentId: T3_A, origin: origin("env_a") },
      { _tag: "Remove", environmentId: T3_B, origin: origin("env_gone") },
    ]);
    expect(result.managedOrigins).toEqual([]);
  });
});

interface Harness {
  readonly layer: Layer.Layer<TrevizeSync.TrevizeCloudSync>;
  readonly requests: Array<string>;
  /** Bodies of `POST /spaces`. */
  readonly createdSpaces: Array<unknown>;
  /** Bodies of `PATCH /spaces/{id}`. */
  readonly updatedSpaces: Array<unknown>;
  /** Bodies of `POST /environments`. */
  readonly createdEnvironments: Array<unknown>;
  /** Bodies of `POST /environments/{id}/threads`. */
  readonly dispatchedThreads: Array<unknown>;
  readonly sentMessages: Array<{ threadId: string; prompt: string }>;
  readonly pairings: Array<ConnectionOnboarding.PairingConnectionInput>;
  readonly removed: Array<EnvironmentId>;
  readonly retried: Array<EnvironmentId>;
  readonly paused: Set<EnvironmentId>;
  readonly optedOut: Array<EnvironmentId>;
  readonly settings: Ref.Ref<TrevizeSync.TrevizeClientSettings>;
}

const readyJson = (id: string) => ({
  status: "ready",
  httpBaseUrl: origin(id),
  wsBaseUrl: origin(id).replace("https:", "wss:"),
  pairingToken: `pairing-${id}`,
  pairingUrl: `https://app.t3.codes/pair#token=pairing-${id}`,
  expiresAt: "2026-10-01T00:10:00.000Z",
  label: id,
});

function spaceJson(id: string, name: string, orchestratorThreadId: string | null = null) {
  return {
    id,
    workspaceId: "ws_1",
    name,
    repositoryIds: ["acme/web"],
    orchestratorThreadId,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
  };
}

const makeHarness = Effect.fn(function* (input: {
  readonly saved: ReadonlyArray<ConnectionCatalogEntry>;
  readonly environments: ReadonlyArray<TrevizeEnvironment>;
  readonly managedOrigins: ReadonlyArray<string>;
  readonly connection?: SupervisorConnectionState;
  readonly threads?: ReadonlyArray<unknown>;
  /** Spaces of every workspace; absent answers 404 like a workspace without spaces. */
  readonly spaces?: ReadonlyArray<unknown>;
  /** Workspace ids; defaults to `ws_1`. */
  readonly workspaces?: ReadonlyArray<string>;
  /** `owner/repo` names connected to each workspace; defaults to `acme/web` everywhere. */
  readonly repositories?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** A follow-up prompt Trevize fails to send. */
  readonly failMessage?: string;
}) {
  const requests: Array<string> = [];
  const createdSpaces: Array<unknown> = [];
  const updatedSpaces: Array<unknown> = [];
  const createdEnvironments: Array<unknown> = [];
  const dispatchedThreads: Array<unknown> = [];
  const sentMessages: Array<{ threadId: string; prompt: string }> = [];
  const pairings: Array<ConnectionOnboarding.PairingConnectionInput> = [];
  const removed: Array<EnvironmentId> = [];
  const retried: Array<EnvironmentId> = [];
  const paused = new Set<EnvironmentId>();
  const optedOut: Array<EnvironmentId> = [];
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(input.saved.map((entry) => [entry.target.environmentId, entry])),
  );
  const settings = yield* Ref.make<TrevizeSync.TrevizeClientSettings>({
    ...TrevizeSync.defaultTrevizeClientSettings("https://trevize.example.test"),
    managedOrigins: input.managedOrigins,
  });

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("unused"),
    assertKnownAddress: () => Effect.die("unused"),
    reconcilePlatform: () => Effect.die("unused"),
    remove: (environmentId) =>
      Effect.gen(function* () {
        removed.push(environmentId);
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
      }),
    removeRoute: () => Effect.die("unused"),
    reorderRoutes: () => Effect.die("unused"),
    removeRelayEnvironments: () => Effect.die("unused"),
    retryNow: (environmentId) => Effect.sync(() => void retried.push(environmentId)),
    setRetriesPaused: (environmentId, isPaused) =>
      Effect.sync(() => void (isPaused ? paused.add(environmentId) : paused.delete(environmentId))),
    stopLearningRoutes: (environmentId) => Effect.sync(() => void optedOut.push(environmentId)),
    setEnabled: () => Effect.die("unused"),
    setCompatibility: () => Effect.die("unused"),
    state: () => Effect.succeed(input.connection ?? AVAILABLE_CONNECTION_STATE),
    stateChanges: () => Stream.empty,
    run: () => Effect.die("unused"),
    runStream: () => Stream.die("unused"),
    followStream: () => Stream.die("unused"),
  });

  const http = layerRemoteHttpClient((request, init = {}) => {
    const url = new URL(String(request));
    requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/workspaces") {
      return Promise.resolve(
        Response.json({
          items: (input.workspaces ?? ["ws_1"]).map((id) => ({ id, name: id, slug: id })),
        }),
      );
    }
    const repositories = /^\/api\/v1\/workspaces\/([^/]+)\/repositories$/.exec(url.pathname);
    if (repositories?.[1] !== undefined) {
      const names = input.repositories ? (input.repositories[repositories[1]] ?? []) : ["acme/web"];
      return Promise.resolve(
        Response.json({
          items: names.map((fullName, index) => ({
            id: index,
            name: fullName.split("/")[1],
            fullName,
            private: true,
          })),
        }),
      );
    }
    if (url.pathname === "/api/v1/environments" && init.method === "POST") {
      createdEnvironments.push(JSON.parse(String(init.body)));
      return Promise.resolve(Response.json(trevizeEnvironment("env_new", "provisioning")));
    }
    if (url.pathname === "/api/v1/environments") {
      return Promise.resolve(Response.json({ environments: input.environments }));
    }
    if (/^\/api\/v1\/environments\/[^/]+\/threads$/.test(url.pathname)) {
      dispatchedThreads.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        Response.json({
          id: "thr_new",
          threadId: "t3-thread-new",
          projectId: "t3-project",
          deepLinkUrl: `${origin("env_new")}/t3-thread-new`,
          existing: false,
        }),
      );
    }
    const message = /^\/api\/v1\/threads\/([^/]+)\/messages$/.exec(url.pathname);
    if (message?.[1] !== undefined) {
      const { prompt } = JSON.parse(String(init.body));
      if (prompt === input.failMessage) {
        return Promise.resolve(Response.json({ message: "boom" }, { status: 500 }));
      }
      sentMessages.push({ threadId: message[1], prompt });
      return Promise.resolve(Response.json({ threadId: message[1] }));
    }
    if (/^\/api\/v1\/environments\/[^/]+\/wake$/.test(url.pathname)) {
      return Promise.resolve(Response.json({ status: "running" }));
    }
    if (url.pathname === "/api/v1/spaces" && (init.method ?? "GET") === "GET") {
      return Promise.resolve(
        input.spaces === undefined
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json({ spaces: input.spaces }),
      );
    }
    if (url.pathname === "/api/v1/spaces") {
      const body = JSON.parse(String(init.body));
      createdSpaces.push(body);
      return Promise.resolve(Response.json(spaceJson("spc_new", body.name)));
    }
    const patched = /^\/api\/v1\/spaces\/([^/]+)$/.exec(url.pathname);
    if (patched?.[1] !== undefined && init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      updatedSpaces.push(body);
      return Promise.resolve(Response.json({ ...spaceJson(patched[1], "Billing"), ...body }));
    }
    if (url.pathname === "/api/v1/threads" && input.threads !== undefined) {
      return Promise.resolve(Response.json({ threads: input.threads }));
    }
    const connect = /^\/api\/v1\/environments\/([^/]+)\/connect$/.exec(url.pathname);
    if (connect?.[1] !== undefined) {
      return Promise.resolve(Response.json(readyJson(connect[1])));
    }
    return Promise.reject(new Error(`Unexpected request: ${url.href}`));
  });

  const layer = TrevizeSync.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        http,
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
        Layer.succeed(
          ConnectionOnboarding.ConnectionOnboarding,
          ConnectionOnboarding.ConnectionOnboarding.of({
            registerPairing: (pairing) =>
              Effect.gen(function* () {
                pairings.push(pairing);
                const environmentId = EnvironmentId.make(`t3-paired-${pairings.length}`);
                yield* SubscriptionRef.update(entries, (current) =>
                  new Map(current).set(
                    environmentId,
                    savedEntry(environmentId, pairing.host ?? ""),
                  ),
                );
                return environmentId;
              }),
            registerSsh: () => Effect.die("unused"),
            updateBearer: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          ConnectionCredentialStore.ConnectionCredentialStore,
          ConnectionCredentialStore.make({
            get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "tvz" })),
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
        Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
        ConnectionWakeups.layer({ changes: Stream.never }),
        Layer.succeed(
          TrevizeSync.TrevizeSettingsStore,
          TrevizeSync.TrevizeSettingsStore.of({
            get: Ref.get(settings),
            update: (f) => Ref.update(settings, f),
          }),
        ),
      ),
    ),
  );
  const harness: Harness = {
    layer,
    requests,
    createdSpaces,
    updatedSpaces,
    createdEnvironments,
    dispatchedThreads,
    sentMessages,
    pairings,
    removed,
    retried,
    paused,
    optedOut,
    settings,
  };
  return harness;
});

const awaitState = (predicate: (state: TrevizeSync.TrevizeCloudSyncState) => boolean) =>
  TrevizeSync.TrevizeCloudSync.pipe(
    Effect.flatMap((sync) =>
      SubscriptionRef.changes(sync.state).pipe(Stream.filter(predicate), Stream.runHead),
    ),
  );

describe("TrevizeCloudSync", () => {
  it.effect("syncs on start and every interval, pairing, removing and marking sleep", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [savedEntry(T3_A, origin("env_a")), savedEntry(T3_B, origin("env_gone"))],
        environments: [
          trevizeEnvironment("env_new", "running"),
          trevizeEnvironment("env_a", "stopped"),
        ],
        managedOrigins: [origin("env_gone")],
      });

      yield* Effect.gen(function* () {
        const first = yield* awaitState((state) => state.lastSyncedAt !== null);
        expect(Option.map(first, (state) => [...state.sleeping.keys()])).toEqual(
          Option.some([T3_A]),
        );
        expect(harness.pairings.map((pairing) => pairing.host)).toEqual([origin("env_new")]);
        expect(harness.removed).toEqual([T3_B]);
        // Saved Trevize environments never keep learned container addresses.
        expect(harness.optedOut).toEqual([T3_A]);
        expect((yield* Ref.get(harness.settings)).managedOrigins).toEqual([
          origin("env_a"),
          origin("env_new"),
        ]);

        yield* TestClock.adjust("30 seconds");
        yield* awaitState((state) => state.lastSyncedAt === 30_000);
        expect(harness.requests.filter((request) => request === "GET /api/v1/workspaces")).toEqual([
          "GET /api/v1/workspaces",
          "GET /api/v1/workspaces",
        ]);
        // The paired environment is saved now, so it is not paired twice, and
        // a stopped one is never woken by background sync.
        expect(harness.pairings).toHaveLength(1);
        expect(harness.requests.filter((request) => request.endsWith("/env_a/connect"))).toEqual(
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("wakes a sleeping environment and retries its connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [savedEntry(T3_A, origin("env_a"))],
        environments: [trevizeEnvironment("env_a", "stopped")],
        managedOrigins: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.sleeping.has(T3_A));
        // A sleeping environment does not keep retrying its connection.
        expect([...harness.paused]).toEqual([T3_A]);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        yield* sync.wake(T3_A);
        expect([...harness.paused]).toEqual([]);

        expect(harness.requests).toContain("POST /api/v1/environments/env_a/wake");
        expect(harness.requests).not.toContain("POST /api/v1/environments/env_a/connect");
        expect(harness.retried).toEqual([T3_A]);
        // The saved credential still works, so the pairing token is not redeemed.
        expect(harness.pairings).toEqual([]);
        expect((yield* SubscriptionRef.get(sync.state)).sleeping.has(T3_A)).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("resumes retries once Trevize reports a sleeping environment running", () =>
    Effect.gen(function* () {
      const environments = [trevizeEnvironment("env_a", "stopped")];
      const harness = yield* makeHarness({
        saved: [savedEntry(T3_A, origin("env_a"))],
        environments,
        managedOrigins: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.sleeping.has(T3_A));
        expect([...harness.paused]).toEqual([T3_A]);

        environments[0] = trevizeEnvironment("env_a", "running");
        yield* TestClock.adjust("30 seconds");
        yield* awaitState((state) => state.lastSyncedAt === 30_000);
        expect([...harness.paused]).toEqual([]);
        expect(harness.retried).toEqual([T3_A]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("re-pairs a saved environment whose credential was rejected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [savedEntry(T3_A, origin("env_a"))],
        environments: [trevizeEnvironment("env_a", "running")],
        managedOrigins: [],
        connection: {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({
            reason: "authentication",
            detail: "The environment credential is invalid.",
          }),
        },
      });

      yield* awaitState((state) => state.lastSyncedAt !== null).pipe(Effect.provide(harness.layer));
      expect(harness.pairings.map((pairing) => pairing.host)).toEqual([origin("env_a")]);
    }),
  );

  it.effect("opens a thread by connecting its environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [trevizeEnvironment("env_a", "stopped")],
        managedOrigins: [],
      });
      const task = { environmentId: "env_a", runtimeThreadId: "t3-thread-1" };

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.lastSyncedAt !== null);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const route = yield* sync.openTask(task);
        // Opening wakes and pairs the unsaved environment, then routes by the T3 id.
        expect(harness.pairings.map((pairing) => pairing.host)).toEqual([origin("env_a")]);
        expect(route).toEqual({ environmentId: "t3-paired-1", threadId: "t3-thread-1" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("launches a cloud session in a fresh environment and routes to its thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length > 0);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const route = yield* sync.launchSession({
          repository: "acme/web",
          prompt: "Fix the flaky checkout test\nIt fails on CI only.",
          providerInstanceId: "codex",
          model: "gpt-5.5",
          branch: "fix/checkout",
        });
        expect(harness.createdEnvironments).toEqual([
          {
            workspaceId: "ws_1",
            repositoryIds: ["acme/web"],
            title: "Fix the flaky checkout test",
          },
        ]);
        // The new environment is paired before the thread starts, so the route opens.
        expect(harness.pairings.map((pairing) => pairing.host)).toEqual([origin("env_new")]);
        expect(harness.dispatchedThreads).toEqual([
          {
            repositoryId: "acme/web",
            prompt: "Fix the flaky checkout test\nIt fails on CI only.",
            providerInstanceId: "codex",
            model: "gpt-5.5",
            dispatchKey: "cloud-session:env_new",
            branch: "fix/checkout",
            // The session has the sandbox to itself, so no worktree.
            worktree: false,
          },
        ]);
        expect(route).toEqual({
          environmentId: "t3-paired-1",
          threadId: "t3-thread-new",
          unsent: [],
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reports launch phases and sends messages queued while it started", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length > 0);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const phases: Array<TrevizeSync.CloudLaunchPhase> = [];
        // Two messages wait when the agent starts; a third arrives while they are sent.
        const queue = [["Also update the docs", "And the changelog"], ["Then open a PR"]];
        const launched = yield* sync.launchSession({
          repository: "acme/web",
          prompt: "Fix the flaky checkout test",
          onPhase: (phase) => phases.push(phase),
          takeQueued: () => {
            // Nothing is taken before the thread exists.
            expect(harness.dispatchedThreads).toHaveLength(1);
            return queue.shift() ?? [];
          },
        });
        expect(phases).toEqual(["creating", "starting", "starting-agent"]);
        expect(harness.sentMessages).toEqual([
          { threadId: "t3-thread-new", prompt: "Also update the docs" },
          { threadId: "t3-thread-new", prompt: "And the changelog" },
          { threadId: "t3-thread-new", prompt: "Then open a PR" },
        ]);
        expect(launched.unsent).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps queued messages after a failed send for the caller", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
        failMessage: "Second",
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length > 0);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const queue = [["First", "Second", "Third"]];
        const launched = yield* sync.launchSession({
          repository: "acme/web",
          prompt: "Start",
          takeQueued: () => queue.shift() ?? [],
        });
        // The session started; only what follows the failed send comes back.
        expect(launched.threadId).toBe("t3-thread-new");
        expect(harness.sentMessages.map((message) => message.prompt)).toEqual(["First"]);
        expect(launched.unsent).toEqual(["Second", "Third"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("launches a cloud session in the workspace that has the repository", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
        workspaces: ["ws_1", "ws_2"],
        repositories: { ws_1: ["acme/api"], ws_2: ["Acme/Web"] },
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length === 2);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        yield* sync.launchSession({ repository: "acme/web", prompt: "Hi" });
        expect(harness.createdEnvironments).toEqual([
          { workspaceId: "ws_2", repositoryIds: ["acme/web"], title: "Hi" },
        ]);

        const error = yield* sync
          .launchSession({ repository: "acme/docs", prompt: "Hi" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "TrevizeRepositoryNotConnectedError",
          repositoryIds: ["acme/docs"],
          connectUrl: "https://trevize.example.test/ws_1/settings/integrations/github",
        });
        expect(error.message).toContain("not connected to any of your Trevize workspaces");
        expect(harness.createdEnvironments).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a cloud session without a workspace that has environments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ saved: [], environments: [], managedOrigins: [] });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.lastSyncedAt !== null);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const error = yield* sync
          .launchSession({ repository: "acme/web", prompt: "Hi" })
          .pipe(Effect.flip);
        expect(error.message).toContain("cloud environments enabled");
        expect(harness.createdEnvironments).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("loads spaces with the threads of their environments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [
          { ...trevizeEnvironment("env_space", "stopped"), spaceId: "spc_1" },
          trevizeEnvironment("env_plain", "stopped"),
        ],
        managedOrigins: [],
        spaces: [spaceJson("spc_1", "Billing", "thr_orch")],
        threads: [
          {
            id: "thr_orch",
            environmentId: "env_space",
            runtimeThreadId: "t3-orch",
            sourceKind: "orchestrator",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            id: "thr_plain",
            environmentId: "env_plain",
            runtimeThreadId: "t3-plain",
            sourceKind: "linear",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });

      const synced = yield* awaitState((state) => state.lastSyncedAt !== null).pipe(
        Effect.provide(harness.layer),
      );
      expect(
        Option.map(synced, (state) => ({
          workspaces: state.spaceWorkspaceIds,
          spaces: state.spaces.map((space) => space.id),
          threads: state.spaceThreads.map((thread) => thread.id),
        })),
      ).toEqual(Option.some({ workspaces: ["ws_1"], spaces: ["spc_1"], threads: ["thr_orch"] }));
      expect(harness.requests).toContain("GET /api/v1/threads?workspaceId=ws_1");
    }),
  );

  it.effect("leaves spaces empty when the workspace has none", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ saved: [], environments: [], managedOrigins: [] });
      const synced = yield* awaitState((state) => state.lastSyncedAt !== null).pipe(
        Effect.provide(harness.layer),
      );
      expect(Option.map(synced, (state) => [state.spaceWorkspaceIds, state.spaces])).toEqual(
        Option.some([[], []]),
      );
      // Threads are only listed for workspaces with spaces.
      expect(harness.requests).not.toContain("GET /api/v1/threads?workspaceId=ws_1");
    }),
  );

  it.effect("creates a space with its orchestrator model and starts nothing itself", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length > 0);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const space = yield* sync.createSpace({
          name: "Billing",
          repositoryIds: ["acme/web"],
          orchestratorModel: { provider: "codex", model: "gpt-5.5" },
        });
        expect(space.id).toBe("spc_new");
        const created = yield* SubscriptionRef.get(sync.state);
        expect(created.spaces.map((candidate) => candidate.id)).toEqual(["spc_new"]);
        expect(harness.createdSpaces).toEqual([
          {
            workspaceId: "ws_1",
            name: "Billing",
            repositoryIds: ["acme/web"],
            orchestrator: { provider: "codex", model: "gpt-5.5" },
          },
        ]);
        expect(harness.requests.filter((request) => request.includes("/spaces/spc_new"))).toEqual(
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("creates a space in the workspace that has all its repositories", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [],
        threads: [],
        workspaces: ["ws_1", "ws_2"],
        repositories: { ws_1: ["acme/web"], ws_2: ["acme/web", "acme/api"] },
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaceWorkspaceIds.length === 2);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        yield* sync.createSpace({ name: "Billing", repositoryIds: ["acme/web", "acme/api"] });
        expect(harness.createdSpaces).toEqual([
          { workspaceId: "ws_2", name: "Billing", repositoryIds: ["acme/web", "acme/api"] },
        ]);

        const error = yield* sync
          .createSpace({ name: "Docs", repositoryIds: ["acme/api", "acme/docs"] })
          .pipe(Effect.flip);
        expect(error.message).toContain("has all of acme/api, acme/docs connected");
        expect(harness.createdSpaces).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("saves space settings and shows them before the next listing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        saved: [],
        environments: [],
        managedOrigins: [],
        spaces: [spaceJson("spc_1", "Billing"), spaceJson("spc_2", "Docs")],
        threads: [],
      });

      yield* Effect.gen(function* () {
        yield* awaitState((state) => state.spaces.length > 0);
        const sync = yield* TrevizeSync.TrevizeCloudSync;
        const patch = { name: "Payments", icon: "🚀", color: "#6e56cf" };
        yield* sync.updateSpace("spc_1", patch);
        expect(harness.updatedSpaces).toEqual([patch]);
        const updated = yield* SubscriptionRef.get(sync.state);
        expect(
          updated.spaces.map(({ id, name, icon, color }) => ({ id, name, icon, color })),
        ).toEqual([
          { id: "spc_1", name: "Payments", icon: "🚀", color: "#6e56cf" },
          { id: "spc_2", name: "Docs", icon: undefined, color: undefined },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
