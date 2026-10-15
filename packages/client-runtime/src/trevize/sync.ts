import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";
import * as ConnectionOnboarding from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import {
  DEFAULT_TREVIZE_API_URL,
  TrevizeApiError,
  archiveSpace as archiveTrevizeSpace,
  createSpace as createTrevizeSpace,
  wakeWhenReady,
  listEnvironments,
  listMyThreads,
  listSpaces,
  listWorkspaceThreads,
  listWorkspaces,
  startOrchestratorWhenReady,
  type TrevizeApiConfig,
  type TrevizeEnvironment,
  type TrevizeOrchestratorModel,
  type TrevizeSpace,
  type TrevizeSpaceInput,
  type TrevizeThread,
} from "./api.ts";
import {
  connectTrevizeEnvironment,
  findSavedTrevizeEnvironment,
  loadTrevizeApiKey,
  trevizeOrigin,
} from "./connect.ts";
import { mergeMyTasks, resolveMyTaskTarget } from "./myTasks.ts";
import { defaultSpaceWorkspaceId } from "./spaces.ts";

/**
 * Non-secret Trevize settings, kept per client. The API key lives in the
 * connection credential store instead. `managedOrigins` are the gateway
 * origins of Trevize environments this client has seen, so sync only ever
 * removes saved environments Trevize handed out, never manual pairings.
 */
export const TrevizeClientSettings = Schema.Struct({
  baseUrl: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  autoConnect: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  managedOrigins: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type TrevizeClientSettings = typeof TrevizeClientSettings.Type;

export function defaultTrevizeClientSettings(baseUrl = DEFAULT_TREVIZE_API_URL) {
  return { baseUrl, workspaceId: null, autoConnect: true, managedOrigins: [] };
}

/** Platform storage for `TrevizeClientSettings`, shared with the settings UI. */
export class TrevizeSettingsStore extends Context.Service<
  TrevizeSettingsStore,
  {
    readonly get: Effect.Effect<TrevizeClientSettings>;
    readonly update: (
      f: (current: TrevizeClientSettings) => TrevizeClientSettings,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/trevize/sync/TrevizeSettingsStore") {}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type TrevizeSyncAction =
  /** Not saved on this device (or its credential was rejected) and running: pair it. */
  | { readonly _tag: "Pair"; readonly environment: TrevizeEnvironment }
  /** Saved, Trevize-managed, and archived or no longer visible to this account. */
  | {
      readonly _tag: "Remove";
      readonly environmentId: EnvironmentId;
      readonly origin: string;
    }
  /** Saved and stopped: the gateway answers 503 until something wakes it. */
  | {
      readonly _tag: "MarkSleeping";
      readonly environmentId: EnvironmentId;
      readonly environment: TrevizeEnvironment;
    }
  | {
      readonly _tag: "Noop";
      readonly environmentId: EnvironmentId | null;
      readonly environment: TrevizeEnvironment;
    };

export interface TrevizeSyncInput {
  /** Every environment of every workspace the account can see. */
  readonly environments: ReadonlyArray<TrevizeEnvironment>;
  readonly saved: ReadonlyArray<ConnectionCatalogEntry>;
  readonly managedOrigins: ReadonlyArray<string>;
  readonly autoConnect: boolean;
  /** Saved environments whose credential the environment rejected. */
  readonly rejectedCredentials: ReadonlySet<EnvironmentId>;
}

export interface TrevizeSyncPlan {
  readonly actions: ReadonlyArray<TrevizeSyncAction>;
  /** The managed-origin set to persist once the actions ran. */
  readonly managedOrigins: ReadonlyArray<string>;
}

/**
 * Decides what one sync does. Pairing only targets `running` environments so
 * background sync never wakes a sleeping sandbox, and an environment that is
 * already saved with a working credential is left alone so sync never mints
 * a second T3 session for this device.
 */
export function planTrevizeSync(input: TrevizeSyncInput): TrevizeSyncPlan {
  const actions: Array<TrevizeSyncAction> = [];
  const listed = new Set<string>();
  const managed = new Set<string>();
  for (const environment of input.environments) {
    const origin = trevizeOrigin(environment.httpBaseUrl);
    if (origin === null) continue;
    listed.add(origin);
    const environmentId = findSavedTrevizeEnvironment(input.saved, origin);
    if (environment.status === "archived") {
      if (environmentId !== null) actions.push({ _tag: "Remove", environmentId, origin });
      continue;
    }
    managed.add(origin);
    if (environmentId !== null && environment.status === "stopped") {
      actions.push({ _tag: "MarkSleeping", environmentId, environment });
    } else if (
      input.autoConnect &&
      environment.status === "running" &&
      (environmentId === null || input.rejectedCredentials.has(environmentId))
    ) {
      actions.push({ _tag: "Pair", environment });
    } else {
      actions.push({ _tag: "Noop", environmentId, environment });
    }
  }
  for (const origin of input.managedOrigins) {
    if (listed.has(origin)) continue;
    const environmentId = findSavedTrevizeEnvironment(input.saved, origin);
    if (environmentId !== null) actions.push({ _tag: "Remove", environmentId, origin });
  }
  return { actions, managedOrigins: [...managed].sort() };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface TrevizeCloudSyncState {
  readonly signedIn: boolean;
  readonly syncing: boolean;
  readonly lastSyncedAt: number | null;
  readonly error: string | null;
  /** Every environment of every workspace, from the last successful sync. */
  readonly environments: ReadonlyArray<TrevizeEnvironment>;
  /** Saved environments Trevize reports as stopped. */
  readonly sleeping: ReadonlyMap<EnvironmentId, TrevizeEnvironment>;
  /** Saved environments a wake is in flight for. */
  readonly waking: ReadonlySet<EnvironmentId>;
  /** Threads assigned to the signed-in user across all workspaces ("My tasks"). */
  readonly myTasks: ReadonlyArray<TrevizeThread>;
  /** Workspaces whose Trevize offers spaces; empty means spaces are unavailable. */
  readonly spaceWorkspaceIds: ReadonlyArray<string>;
  /** Live (not archived) spaces of those workspaces. */
  readonly spaces: ReadonlyArray<TrevizeSpace>;
  /** Threads of those workspaces that run in a space's environment. */
  readonly spaceThreads: ReadonlyArray<TrevizeThread>;
  /** Spaces whose orchestrator is being started from this device. */
  readonly startingSpaces: ReadonlySet<string>;
  /** Why the last orchestrator start of a space failed, until it is retried. */
  readonly spaceStartErrors: ReadonlyMap<string, string>;
}

export const EMPTY_TREVIZE_CLOUD_SYNC_STATE: TrevizeCloudSyncState = {
  signedIn: false,
  syncing: false,
  lastSyncedAt: null,
  error: null,
  environments: [],
  sleeping: new Map(),
  waking: new Set(),
  myTasks: [],
  spaceWorkspaceIds: [],
  spaces: [],
  spaceThreads: [],
  startingSpaces: new Set(),
  spaceStartErrors: new Map(),
};

/** What a new space needs; the workspace defaults to the one picked in settings. */
export interface CreateSpaceInput extends Omit<TrevizeSpaceInput, "workspaceId"> {
  readonly workspaceId?: string;
  /** The orchestrator's model, applied when it first starts. */
  readonly orchestratorModel?: TrevizeOrchestratorModel | null;
}

export class TrevizeCloudSync extends Context.Service<
  TrevizeCloudSync,
  {
    readonly state: SubscriptionRef.SubscriptionRef<TrevizeCloudSyncState>;
    /** Asks the sync loop to run now. Returns once requested, not once done. */
    readonly syncNow: Effect.Effect<void>;
    /**
     * Wakes a saved, sleeping Trevize environment through Trevize `wake`,
     * then retries its connection immediately. The saved credential still
     * works, so no pairing token is minted.
     */
    readonly wake: (environmentId: EnvironmentId) => Effect.Effect<void, TrevizeApiError>;
    /**
     * Makes a "My tasks" thread openable on this device and returns its route:
     * wakes its environment when it sleeps, or connects it when this device
     * has not saved it yet.
     */
    readonly openTask: (
      task: Pick<TrevizeThread, "environmentId" | "runtimeThreadId">,
    ) => Effect.Effect<
      { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
      TrevizeApiError
    >;
    /**
     * Creates a space and starts its orchestrator in the background (see
     * `startOrchestrator`). Returns once the space exists.
     */
    readonly createSpace: (input: CreateSpaceInput) => Effect.Effect<TrevizeSpace, TrevizeApiError>;
    /**
     * Starts a space's orchestrator in the background, polling while its
     * environment provisions. Progress shows in `startingSpaces` and
     * `spaceStartErrors`; a start already in flight is not repeated.
     */
    readonly startOrchestrator: (
      spaceId: string,
      model?: TrevizeOrchestratorModel | null,
    ) => Effect.Effect<void>;
    readonly archiveSpace: (spaceId: string) => Effect.Effect<void, TrevizeApiError>;
  }
>()("@t3tools/client-runtime/trevize/sync/TrevizeCloudSync") {}

const SYNC_INTERVAL = Duration.seconds(30);
/** Background pairing only targets running environments, so this is short. */
const PAIR_MAX_WAIT_MS = 30_000;

interface SpaceListing {
  readonly workspaceId: string;
  readonly spaces: ReadonlyArray<TrevizeSpace>;
  readonly threads: ReadonlyArray<TrevizeThread>;
}

type MergedSpaces = Pick<TrevizeCloudSyncState, "spaceWorkspaceIds" | "spaces" | "spaceThreads">;

/** Keeps live spaces and the threads that run in a space's environment. */
function mergeSpaceListings(
  listings: ReadonlyArray<Option.Option<SpaceListing>>,
  environments: ReadonlyArray<TrevizeEnvironment>,
): MergedSpaces {
  const available = listings.flatMap((listing) => (Option.isSome(listing) ? [listing.value] : []));
  const spaceEnvironments = new Set(
    environments.filter((environment) => environment.spaceId).map((environment) => environment.id),
  );
  return {
    spaceWorkspaceIds: available.map((listing) => listing.workspaceId),
    spaces: available.flatMap((listing) => listing.spaces.filter((space) => !space.archivedAt)),
    spaceThreads: available.flatMap((listing) =>
      listing.threads.filter((thread) => spaceEnvironments.has(thread.environmentId)),
    ),
  };
}

interface LoadedConfig {
  readonly config: TrevizeApiConfig;
  readonly settings: TrevizeClientSettings;
}

function isCredentialRejected(state: SupervisorConnectionState) {
  return (
    state.phase === "blocked" &&
    state.lastFailure?._tag === "ConnectionBlockedError" &&
    state.lastFailure.reason === "authentication"
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("TrevizeCloudSync.make")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const settingsStore = yield* TrevizeSettingsStore;
  const connectivity = yield* Connectivity.Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const context = yield* Effect.context<
    | ConnectionCredentialStore.ConnectionCredentialStore
    | ConnectionOnboarding.ConnectionOnboarding
    | HttpClient.HttpClient
  >();
  const state = yield* SubscriptionRef.make(EMPTY_TREVIZE_CLOUD_SYNC_STATE);
  const serviceScope = yield* Scope.Scope;
  const requests = yield* Queue.sliding<void>(1);
  const waking = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const loadConfig = Effect.gen(function* () {
    const apiKey = yield* loadTrevizeApiKey().pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(apiKey)) return Option.none<LoadedConfig>();
    const settings = yield* settingsStore.get;
    return Option.some<LoadedConfig>({
      config: { baseUrl: settings.baseUrl, apiKey: apiKey.value },
      settings,
    });
  }).pipe(Effect.provideContext(context));

  const resumeRetries = (environmentIds: ReadonlyArray<EnvironmentId>) =>
    Effect.forEach(
      environmentIds,
      (environmentId) =>
        registry
          .setRetriesPaused(environmentId, false)
          .pipe(Effect.andThen(registry.retryNow(environmentId))),
      { discard: true },
    );

  const syncOnce = Effect.gen(function* () {
    const loaded = yield* loadConfig;
    if (Option.isNone(loaded)) {
      const previous = yield* SubscriptionRef.getAndUpdate(state, (current) => ({
        ...EMPTY_TREVIZE_CLOUD_SYNC_STATE,
        waking: current.waking,
      }));
      yield* resumeRetries([...previous.sleeping.keys()]);
      return;
    }
    if ((yield* connectivity.status) === "offline") return;
    const { config, settings } = loaded.value;
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      signedIn: true,
      syncing: true,
    }));

    // Any failed listing aborts the whole sync: a partial list would look
    // like lost access and remove environments that are fine.
    const workspaces = yield* listWorkspaces(config);
    const environments = (yield* Effect.forEach(
      workspaces,
      (workspace) => listEnvironments(config, workspace.id),
      { concurrency: 4 },
    )).flat();
    // Tasks are best effort: an older Trevize without the endpoint, or one
    // failed workspace, keeps the last list instead of failing the sync.
    const myTasks = yield* Effect.forEach(
      workspaces,
      (workspace) => listMyThreads(config, workspace.id),
      { concurrency: 4 },
    ).pipe(
      Effect.map((listings) => Option.some(mergeMyTasks(listings))),
      Effect.catch((error) =>
        Effect.logWarning("Could not list Trevize tasks.", { error }).pipe(
          Effect.as(Option.none<ReadonlyArray<TrevizeThread>>()),
        ),
      ),
    );

    // Spaces are best effort like tasks. A 404 means the workspace has no
    // spaces; its threads are only listed when it does.
    const spaceListing = yield* Effect.forEach(
      workspaces,
      (workspace) =>
        listSpaces(config, workspace.id).pipe(
          Effect.flatMap((spaces) =>
            Option.isNone(spaces)
              ? Effect.succeed(Option.none<SpaceListing>())
              : listWorkspaceThreads(config, workspace.id).pipe(
                  Effect.map((threads) =>
                    Option.some<SpaceListing>({
                      workspaceId: workspace.id,
                      spaces: spaces.value,
                      threads,
                    }),
                  ),
                ),
          ),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((listings) => Option.some(mergeSpaceListings(listings, environments))),
      Effect.catch((error) =>
        Effect.logWarning("Could not list Trevize spaces.", { error }).pipe(
          Effect.as(Option.none<MergedSpaces>()),
        ),
      ),
    );

    const saved = [...(yield* SubscriptionRef.get(registry.entries)).values()];
    const rejectedCredentials = new Set<EnvironmentId>();
    for (const entry of saved) {
      const environmentId = entry.target.environmentId;
      const connection = yield* registry
        .state(environmentId)
        .pipe(Effect.orElseSucceed(() => null));
      if (connection !== null && isCredentialRejected(connection)) {
        rejectedCredentials.add(environmentId);
      }
    }
    const plan = planTrevizeSync({
      environments,
      saved,
      managedOrigins: settings.managedOrigins,
      autoConnect: settings.autoConnect,
      rejectedCredentials,
    });

    const sleeping = new Map<EnvironmentId, TrevizeEnvironment>();
    const wasSleeping = (yield* SubscriptionRef.get(state)).sleeping;
    const keptOrigins: Array<string> = [];
    for (const action of plan.actions) {
      switch (action._tag) {
        case "Pair":
          yield* connectTrevizeEnvironment({
            config,
            environment: action.environment,
            maxWaitMs: PAIR_MAX_WAIT_MS,
          }).pipe(
            Effect.provideContext(context),
            Effect.catch((error) =>
              Effect.logWarning("Could not connect a Trevize environment.", {
                environmentId: action.environment.id,
                error,
              }),
            ),
          );
          break;
        case "Remove":
          yield* registry.remove(action.environmentId).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // Keep it managed so the next sync tries again.
                keptOrigins.push(action.origin);
                yield* Effect.logWarning("Could not remove a Trevize environment.", {
                  environmentId: action.environmentId,
                  error,
                });
              }),
            ),
          );
          break;
        case "MarkSleeping":
          sleeping.set(action.environmentId, action.environment);
          // The gateway answers 503 until something wakes it, so stop retrying.
          yield* registry.setRetriesPaused(action.environmentId, true);
          break;
        case "Noop":
          break;
      }
    }

    // Environments paired before Trevize pairings opted out of route learning
    // may hold learned container addresses that bypass the gateway.
    for (const action of plan.actions) {
      if ((action._tag !== "MarkSleeping" && action._tag !== "Noop") || !action.environmentId) {
        continue;
      }
      yield* registry.stopLearningRoutes(action.environmentId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not drop learned routes of a Trevize environment.", {
            environmentId: action.environmentId,
            error,
          }),
        ),
      );
    }

    // Woken elsewhere (another device, Trevize itself): connect again.
    yield* resumeRetries([...wasSleeping.keys()].filter((id) => !sleeping.has(id)));

    const managedOrigins = [...new Set([...plan.managedOrigins, ...keptOrigins])].sort();
    if (managedOrigins.join("\n") !== [...settings.managedOrigins].sort().join("\n")) {
      yield* settingsStore.update((current) => ({ ...current, managedOrigins }));
    }
    const now = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      signedIn: true,
      syncing: false,
      lastSyncedAt: now,
      error: null,
      environments,
      sleeping,
      myTasks: Option.getOrElse(myTasks, () => current.myTasks),
      ...Option.getOrElse(spaceListing, () => ({
        spaceWorkspaceIds: current.spaceWorkspaceIds,
        spaces: current.spaces,
        spaceThreads: current.spaceThreads,
      })),
    }));
  }).pipe(
    Effect.catch((error) =>
      SubscriptionRef.update(state, (current) => ({
        ...current,
        syncing: false,
        error: error.message,
      })),
    ),
    Effect.withSpan("TrevizeCloudSync.sync"),
  );

  const syncNow = Queue.offer(requests, undefined).pipe(Effect.asVoid);

  const setWaking = (environmentId: EnvironmentId, active: boolean) =>
    Ref.updateAndGet(waking, (current) => {
      const next = new Set(current);
      if (active) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    }).pipe(
      Effect.flatMap((next) =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          waking: next,
        })),
      ),
    );

  const wake = Effect.fn("TrevizeCloudSync.wake")(function* (environmentId: EnvironmentId) {
    if ((yield* Ref.get(waking)).has(environmentId)) return;
    const loaded = yield* loadConfig;
    if (Option.isNone(loaded)) {
      return yield* new TrevizeApiError({
        reason: "unauthorized",
        message: "Sign in to Trevize Cloud to wake this environment.",
      });
    }
    const current = yield* SubscriptionRef.get(state);
    const saved = [...(yield* SubscriptionRef.get(registry.entries)).values()];
    const environment =
      current.sleeping.get(environmentId) ??
      current.environments.find(
        (candidate) => findSavedTrevizeEnvironment(saved, candidate.httpBaseUrl) === environmentId,
      );
    if (environment === undefined) {
      return yield* new TrevizeApiError({
        reason: "request",
        message: "Trevize does not list this environment.",
      });
    }
    yield* setWaking(environmentId, true);
    yield* Effect.gen(function* () {
      yield* wakeWhenReady(loaded.value.config, environment.id).pipe(
        Effect.provideContext(context),
      );
      yield* SubscriptionRef.update(state, (latest) => {
        const sleeping = new Map(latest.sleeping);
        sleeping.delete(environmentId);
        return { ...latest, sleeping };
      });
      yield* registry.setRetriesPaused(environmentId, false);
      yield* registry.retryNow(environmentId);
      yield* syncNow;
    }).pipe(Effect.ensuring(setWaking(environmentId, false)));
  });

  const openTask = Effect.fn("TrevizeCloudSync.openTask")(function* (
    task: Pick<TrevizeThread, "environmentId" | "runtimeThreadId">,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const saved = (yield* SubscriptionRef.get(registry.entries)).values();
    const target = resolveMyTaskTarget(task, current.environments, saved);
    switch (target._tag) {
      case "Unavailable":
        return yield* new TrevizeApiError({ reason: "request", message: target.reason });
      case "Saved":
        if (target.sleeping) yield* wake(target.environmentId);
        return { environmentId: target.environmentId, threadId: target.threadId };
      case "Connect": {
        const loaded = yield* loadConfig;
        if (Option.isNone(loaded)) {
          return yield* new TrevizeApiError({
            reason: "unauthorized",
            message: "Sign in to Trevize Cloud to open this task.",
          });
        }
        const environmentId = yield* connectTrevizeEnvironment({
          config: loaded.value.config,
          environment: target.environment,
        }).pipe(
          Effect.provideContext(context),
          Effect.mapError((error) =>
            error._tag === "TrevizeApiError"
              ? error
              : new TrevizeApiError({ reason: "request", message: error.message }),
          ),
        );
        yield* syncNow;
        return { environmentId, threadId: target.threadId };
      }
    }
  });

  const requireConfig = (action: string) =>
    loadConfig.pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.mapError(
        () =>
          new TrevizeApiError({
            reason: "unauthorized",
            message: `Sign in to Trevize Cloud to ${action}.`,
          }),
      ),
    );

  const setStarting = (spaceId: string, starting: boolean, error: string | null) =>
    SubscriptionRef.update(state, (current) => {
      const startingSpaces = new Set(current.startingSpaces);
      if (starting) startingSpaces.add(spaceId);
      else startingSpaces.delete(spaceId);
      const spaceStartErrors = new Map(current.spaceStartErrors);
      if (error === null) spaceStartErrors.delete(spaceId);
      else spaceStartErrors.set(spaceId, error);
      return { ...current, startingSpaces, spaceStartErrors };
    });

  const startOrchestrator = Effect.fn("TrevizeCloudSync.startOrchestrator")(function* (
    spaceId: string,
    model?: TrevizeOrchestratorModel | null,
  ) {
    if ((yield* SubscriptionRef.get(state)).startingSpaces.has(spaceId)) return;
    yield* setStarting(spaceId, true, null);
    yield* Effect.gen(function* () {
      const { config } = yield* requireConfig("start the orchestrator");
      const started = yield* startOrchestratorWhenReady(config, spaceId, { model: model ?? null });
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        spaces: current.spaces.map((space) =>
          space.id === spaceId ? { ...space, orchestratorThreadId: started.threadId } : space,
        ),
      }));
      // The next listing carries the orchestrator thread and pairs its environment.
      yield* syncNow;
      yield* setStarting(spaceId, false, null);
    }).pipe(
      Effect.provideContext(context),
      Effect.catch((error) => setStarting(spaceId, false, error.message)),
      Effect.onInterrupt(() => setStarting(spaceId, false, null)),
      // Outlives the caller: the start keeps polling after its view is gone.
      Effect.forkIn(serviceScope),
    );
  });

  const createSpace = Effect.fn("TrevizeCloudSync.createSpace")(function* (
    input: CreateSpaceInput,
  ) {
    const { config, settings } = yield* requireConfig("create a space");
    const current = yield* SubscriptionRef.get(state);
    const workspaceId =
      input.workspaceId ?? defaultSpaceWorkspaceId(settings.workspaceId, current.spaceWorkspaceIds);
    if (workspaceId === null) {
      return yield* new TrevizeApiError({
        reason: "request",
        message: "None of your Trevize workspaces has spaces enabled.",
      });
    }
    const space = yield* createTrevizeSpace(config, { ...input, workspaceId }).pipe(
      Effect.provideContext(context),
    );
    yield* SubscriptionRef.update(state, (latest) => ({
      ...latest,
      spaces: [space, ...latest.spaces.filter((candidate) => candidate.id !== space.id)],
    }));
    yield* startOrchestrator(space.id, input.orchestratorModel ?? null);
    return space;
  });

  const archiveSpace = Effect.fn("TrevizeCloudSync.archiveSpace")(function* (spaceId: string) {
    const { config } = yield* requireConfig("archive this space");
    yield* archiveTrevizeSpace(config, spaceId).pipe(Effect.provideContext(context));
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      spaces: current.spaces.filter((space) => space.id !== spaceId),
    }));
    yield* syncNow;
  });

  // The one sync loop: runs at start, then on request or every interval.
  yield* Effect.gen(function* () {
    while (true) {
      yield* syncOnce;
      yield* Queue.take(requests).pipe(Effect.timeoutOption(SYNC_INTERVAL));
    }
  }).pipe(Effect.forkScoped);
  yield* wakeups.changes.pipe(
    Stream.filter(ConnectionWakeups.resetsRetryBackoff),
    Stream.runForEach(() => syncNow),
    Effect.forkScoped,
  );

  return TrevizeCloudSync.of({
    state,
    syncNow,
    wake,
    openTask,
    createSpace,
    startOrchestrator,
    archiveSpace,
  });
});

export const layer = Layer.effect(TrevizeCloudSync, make());
