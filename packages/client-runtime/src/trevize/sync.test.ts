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

const makeHarness = Effect.fn(function* (input: {
  readonly saved: ReadonlyArray<ConnectionCatalogEntry>;
  readonly environments: ReadonlyArray<TrevizeEnvironment>;
  readonly managedOrigins: ReadonlyArray<string>;
  readonly connection?: SupervisorConnectionState;
}) {
  const requests: Array<string> = [];
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
    registerPlatform: () => Effect.die("unused"),
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
        Response.json({ items: [{ id: "ws_1", name: "Acme", slug: "acme" }] }),
      );
    }
    if (url.pathname === "/api/v1/environments") {
      return Promise.resolve(Response.json({ environments: input.environments }));
    }
    if (/^\/api\/v1\/environments\/[^/]+\/wake$/.test(url.pathname)) {
      return Promise.resolve(Response.json({ status: "running" }));
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
            get: () =>
              Effect.succeed(Option.some(new BearerConnectionCredential({ token: "tvz" }))),
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
});
