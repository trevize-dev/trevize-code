import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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
  TrevizeRepositoryNotConnectedError,
  archiveEnvironment,
  archiveSpace as archiveTrevizeSpace,
  createEnvironment as createTrevizeEnvironment,
  createSpace as createTrevizeSpace,
  dispatchThread,
  getEnvironment,
  sendThreadMessage,
  updateSpace as updateTrevizeSpace,
  wakeWhenReady,
  listEnvironments,
  listRepositories,
  listSpaceMembers as listTrevizeSpaceMembers,
  listSpaces,
  listWorkspaceMembers as listTrevizeWorkspaceMembers,
  listWorkspaceThreads,
  listWorkspaces,
  removeSpaceMember as removeTrevizeSpaceMember,
  setSpaceMember as setTrevizeSpaceMember,
  type TrevizeApiConfig,
  type TrevizeEnvironment,
  type TrevizeEnvironmentStatus,
  type TrevizeWakeProgress,
  type TrevizeSpace,
  type TrevizeSpaceInput,
  type TrevizeSpaceMember,
  type TrevizeSpacePatch,
  type TrevizeSpaceRole,
  type TrevizeThread,
  type TrevizeWorkspace,
  type TrevizeWorkspaceMember,
} from "./api.ts";
import {
  connectTrevizeEnvironment,
  findSavedTrevizeEnvironment,
  loadTrevizeApiKey,
  trevizeOrigin,
} from "./connect.ts";
import { resolveMyTaskTarget } from "./myTasks.ts";
import { connectRepositoriesUrl, connectedRepositoryKeys, placeRepositories } from "./spaces.ts";

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

export type TrevizeSyncAction =
  /** Not saved on this device (or its credential was rejected) and running: pair it. */
  | { readonly _tag: "Pair"; readonly environment: TrevizeEnvironment }
  /**
   * Saved, running, and its address now answers as a different environment:
   * the sandbox was replaced by one whose server has another id (Trevize
   * keeps the id across replacements since, so mostly older replacements).
   * Pair the new server, then drop the saved entry it replaced.
   */
  | {
      readonly _tag: "Replace";
      readonly environmentId: EnvironmentId;
      readonly environment: TrevizeEnvironment;
    }
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
  /** Saved environments whose address now answers as another environment. */
  readonly replacedEnvironments: ReadonlySet<EnvironmentId>;
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
      environmentId !== null &&
      input.replacedEnvironments.has(environmentId)
    ) {
      actions.push({ _tag: "Replace", environmentId, environment });
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

/**
 * Where a saved Trevize environment that is not running stands, as Trevize
 * last reported it: asleep, starting (with the start's phase), or failed.
 */
export interface TrevizeStartProgress {
  readonly status: Exclude<TrevizeEnvironmentStatus, "running" | "archived">;
  /** The start's phase (see `TrevizeEnvironmentStart`); null when unknown. */
  readonly phase: string | null;
  /** The sandbox broke on the provider; the start rebuilds it on a new one. */
  readonly recovering: boolean;
  /** Why the last start failed (`failed` only). */
  readonly error: string | null;
}

/** Whether Trevize is starting the environment right now. */
export function isTrevizeStartInFlight(progress: TrevizeStartProgress): boolean {
  return progress.status === "provisioning" || progress.status === "starting";
}

/** Start progress from a listing; null while the environment runs or is archived. */
function startProgressFromEnvironment(
  environment: TrevizeEnvironment,
): TrevizeStartProgress | null {
  if (environment.status === "running" || environment.status === "archived") return null;
  return {
    status: environment.status,
    phase: environment.start?.phase ?? null,
    recovering: environment.start?.recovering ?? false,
    error: environment.status === "failed" ? (environment.error ?? null) : null,
  };
}

/** Start progress from one `wake` poll; null once the environment runs. */
function startProgressFromWake(wake: TrevizeWakeProgress): TrevizeStartProgress | null {
  if (wake.status === "ready" || wake.status === "running") return null;
  if (wake.status === "failed") {
    return { status: "failed", phase: null, recovering: false, error: wake.error };
  }
  return { status: "starting", phase: wake.phase, recovering: wake.recovering, error: null };
}

/**
 * Saved environments that run one-off cloud sessions: Trevize environments
 * outside spaces, which Trevize itself treats as single tasks. New threads
 * never default to them, and they archive instead of settling.
 */
function findCloudSessionEnvironments(
  environments: ReadonlyArray<TrevizeEnvironment>,
  saved: ReadonlyArray<ConnectionCatalogEntry>,
): ReadonlyMap<EnvironmentId, TrevizeEnvironment> {
  const sessions = new Map<EnvironmentId, TrevizeEnvironment>();
  for (const environment of environments) {
    if (environment.spaceId || environment.status === "archived") continue;
    const environmentId = findSavedTrevizeEnvironment(saved, environment.httpBaseUrl);
    if (environmentId !== null) sessions.set(environmentId, environment);
  }
  return sessions;
}

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
  /**
   * Saved Trevize environments that are not running, with what Trevize
   * reports about them. Refreshed every few seconds while a start runs.
   */
  readonly progress: ReadonlyMap<EnvironmentId, TrevizeStartProgress>;
  /** Saved environments of one-off cloud sessions (`findCloudSessionEnvironments`). */
  readonly sessionEnvironments: ReadonlyMap<EnvironmentId, TrevizeEnvironment>;
  /** Workspaces whose Trevize offers spaces; empty means spaces are unavailable. */
  readonly spaceWorkspaceIds: ReadonlyArray<string>;
  /** Live (not archived) spaces of those workspaces. */
  readonly spaces: ReadonlyArray<TrevizeSpace>;
  /** Threads of those workspaces that run in a space's environment. */
  readonly spaceThreads: ReadonlyArray<TrevizeThread>;
  /** Every workspace the user can see. */
  readonly workspaces: ReadonlyArray<TrevizeWorkspace>;
  /**
   * Connected repository keys (`connectedRepositoryKeys`) of the workspaces
   * with spaces; a workspace whose listing failed is missing.
   */
  readonly connectedRepositories: ReadonlyMap<string, ReadonlySet<string>>;
}

export const EMPTY_TREVIZE_CLOUD_SYNC_STATE: TrevizeCloudSyncState = {
  signedIn: false,
  syncing: false,
  lastSyncedAt: null,
  error: null,
  environments: [],
  sleeping: new Map(),
  waking: new Set(),
  progress: new Map(),
  sessionEnvironments: new Map(),
  spaceWorkspaceIds: [],
  spaces: [],
  spaceThreads: [],
  workspaces: [],
  connectedRepositories: new Map(),
};

/**
 * What a cloud session launch is doing, in order: creating its environment,
 * waiting for the sandbox to boot and check out the repository, then starting
 * the agent thread.
 */
export type CloudLaunchPhase = "creating" | "starting" | "starting-agent";

/** A one-off cloud session: one fresh environment running one agent thread. */
export interface LaunchSessionInput {
  /** `owner/repo`, cloned into the new environment. */
  readonly repository: string;
  /** The thread's first message; its first line names the environment. */
  readonly prompt: string;
  /** A T3 provider instance id, e.g. `codex`. */
  readonly providerInstanceId?: string;
  readonly model?: string;
  /** The branch to work on; the repository's default branch otherwise. */
  readonly branch?: string;
  /** Told each phase as the launch reaches it. */
  readonly onPhase?: (phase: CloudLaunchPhase) => void;
  /**
   * Takes the messages sent while the session started. Called once the agent
   * runs, and again after each batch is sent, until it returns none.
   */
  readonly takeQueued?: () => ReadonlyArray<string>;
}

/** A launched cloud session, plus queued messages that could not be sent to it. */
export interface LaunchedSession {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly unsent: ReadonlyArray<string>;
}

/** A cloud session environment's title: the prompt's first line, shortened. */
export function cloudSessionTitle(prompt: string): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- persisted as the cloud environment's title in Trevize, like user content
  return truncate(prompt.trim().split("\n", 1)[0] ?? "", 80) || "Cloud session";
}

/** Signed in, with a workspace whose Trevize offers environments (and so spaces). */
export function hasCloudEnvironments(
  state: Pick<TrevizeCloudSyncState, "signedIn" | "spaceWorkspaceIds">,
): boolean {
  return state.signedIn && state.spaceWorkspaceIds.length > 0;
}

/** What a new space needs; the workspace defaults to one that has all its repositories. */
export interface CreateSpaceInput extends Omit<TrevizeSpaceInput, "workspaceId"> {
  readonly workspaceId?: string;
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
     * Makes a Trevize thread openable on this device and returns its route:
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
     * Creates a space; Trevize launches its orchestrator in the background,
     * and a later listing carries its thread. Returns once the space exists.
     */
    readonly createSpace: (
      input: CreateSpaceInput,
    ) => Effect.Effect<TrevizeSpace, TrevizeApiError | TrevizeRepositoryNotConnectedError>;
    /** Saves a space's settings and shows them without waiting for the next listing. */
    readonly updateSpace: (
      spaceId: string,
      patch: TrevizeSpacePatch,
    ) => Effect.Effect<TrevizeSpace, TrevizeApiError>;
    readonly archiveSpace: (spaceId: string) => Effect.Effect<void, TrevizeApiError>;
    readonly listSpaceMembers: (
      spaceId: string,
    ) => Effect.Effect<ReadonlyArray<TrevizeSpaceMember>, TrevizeApiError>;
    readonly listWorkspaceMembers: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<TrevizeWorkspaceMember>, TrevizeApiError>;
    /** Adds a member or changes a role, then syncs, since it may change the caller's own role. */
    readonly setSpaceMember: (input: {
      readonly spaceId: string;
      readonly userId: string;
      readonly role: TrevizeSpaceRole;
    }) => Effect.Effect<TrevizeSpaceMember, TrevizeApiError>;
    /** Removes a member, then syncs. `leaving` (yourself, members-only) hides the space right away. */
    readonly removeSpaceMember: (input: {
      readonly spaceId: string;
      readonly userId: string;
      readonly leaving: boolean;
    }) => Effect.Effect<void, TrevizeApiError>;
    /**
     * Starts a cloud session: creates a fresh environment for one repository,
     * waits for it and pairs this device, then starts a thread with the first
     * prompt. Returns the thread's route; cold starts can take minutes.
     */
    readonly launchSession: (
      input: LaunchSessionInput,
    ) => Effect.Effect<LaunchedSession, TrevizeApiError | TrevizeRepositoryNotConnectedError>;
    /**
     * Archives a cloud session's environment on Trevize and forgets it on
     * this device. Needs only Trevize, so it works while the sandbox is
     * asleep or unreachable. Does nothing for other environments.
     */
    readonly archiveSession: (environmentId: EnvironmentId) => Effect.Effect<void, TrevizeApiError>;
  }
>()("@t3tools/client-runtime/trevize/sync/TrevizeCloudSync") {}

const SYNC_INTERVAL = Duration.seconds(30);
/** How often a start's progress is polled while one runs. */
const START_PROGRESS_INTERVAL = Duration.seconds(3);
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

/** Blocked because the saved address now answers as a different environment. */
function isEnvironmentReplaced(state: SupervisorConnectionState) {
  return (
    state.phase === "blocked" &&
    state.lastFailure?._tag === "ConnectionBlockedError" &&
    state.lastFailure.reachedEnvironmentId !== undefined
  );
}

function isCredentialRejected(state: SupervisorConnectionState) {
  return (
    state.phase === "blocked" &&
    state.lastFailure?._tag === "ConnectionBlockedError" &&
    state.lastFailure.reason === "authentication"
  );
}

/** @public */
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

    // Best effort per workspace: a failed listing keeps what the last one saw.
    const previousRepositories = (yield* SubscriptionRef.get(state)).connectedRepositories;
    const connectedRepositories = new Map(
      yield* Effect.forEach(
        Option.match(spaceListing, {
          onNone: () => [...previousRepositories.keys()],
          onSome: (merged) => merged.spaceWorkspaceIds,
        }),
        (workspaceId) =>
          listRepositories(config, workspaceId).pipe(
            Effect.provideContext(context),
            Effect.map((repositories) => [connectedRepositoryKeys(repositories)]),
            Effect.orElseSucceed(() => {
              const previous = previousRepositories.get(workspaceId);
              return previous === undefined ? [] : [previous];
            }),
            Effect.map((keys) => keys.map((value) => [workspaceId, value] as const)),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((entries) => entries.flat())),
    );

    const saved = [...(yield* SubscriptionRef.get(registry.entries)).values()];
    const rejectedCredentials = new Set<EnvironmentId>();
    const replacedEnvironments = new Set<EnvironmentId>();
    for (const entry of saved) {
      const environmentId = entry.target.environmentId;
      const connection = yield* registry
        .state(environmentId)
        .pipe(Effect.orElseSucceed(() => null));
      if (connection !== null && isCredentialRejected(connection)) {
        rejectedCredentials.add(environmentId);
      }
      if (connection !== null && isEnvironmentReplaced(connection)) {
        replacedEnvironments.add(environmentId);
      }
    }
    const progress = new Map<EnvironmentId, TrevizeStartProgress>();
    for (const environment of environments) {
      const environmentId = findSavedTrevizeEnvironment(saved, environment.httpBaseUrl);
      const entry = startProgressFromEnvironment(environment);
      if (environmentId !== null && entry !== null) progress.set(environmentId, entry);
    }
    const plan = planTrevizeSync({
      environments,
      saved,
      managedOrigins: settings.managedOrigins,
      autoConnect: settings.autoConnect,
      rejectedCredentials,
      replacedEnvironments,
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
        case "Replace": {
          const paired = yield* connectTrevizeEnvironment({
            config,
            environment: action.environment,
            maxWaitMs: PAIR_MAX_WAIT_MS,
          }).pipe(
            Effect.provideContext(context),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning("Could not connect a replaced Trevize environment.", {
                  environmentId: action.environment.id,
                  error,
                }),
                null,
              ),
            ),
          );
          // Only once the new server is saved, so a failed pairing keeps the
          // old entry (and its threads) for the next sync to try again.
          if (paired !== null && paired !== action.environmentId) {
            yield* registry.remove(action.environmentId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not remove a replaced Trevize environment.", {
                  environmentId: action.environmentId,
                  error,
                }),
              ),
            );
          }
          break;
        }
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
    // Read after the actions, so environments paired just now count.
    const sessionEnvironments = findCloudSessionEnvironments(environments, [
      ...(yield* SubscriptionRef.get(registry.entries)).values(),
    ]);
    const now = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      signedIn: true,
      syncing: false,
      lastSyncedAt: now,
      error: null,
      environments,
      sleeping,
      progress,
      sessionEnvironments,
      workspaces,
      connectedRepositories,
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

  const setProgress = (environmentId: EnvironmentId, entry: TrevizeStartProgress | null) =>
    SubscriptionRef.update(state, (current) => {
      const progress = new Map(current.progress);
      if (entry === null) progress.delete(environmentId);
      else progress.set(environmentId, entry);
      return { ...current, progress };
    });

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
      yield* wakeWhenReady(loaded.value.config, environment.id, {
        onProgress: (wakeProgress) =>
          setProgress(environmentId, startProgressFromWake(wakeProgress)),
      }).pipe(Effect.provideContext(context));
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

  /** Waits for a Trevize environment and pairs this device with it. */
  const connect = (
    config: TrevizeApiConfig,
    environment: Pick<TrevizeEnvironment, "id" | "title">,
  ) =>
    connectTrevizeEnvironment({ config, environment }).pipe(
      Effect.provideContext(context),
      Effect.mapError((error) =>
        error._tag === "TrevizeApiError"
          ? error
          : new TrevizeApiError({ reason: "request", message: error.message }),
      ),
    );

  const openTask = Effect.fn("TrevizeCloudSync.openTask")(function* (
    task: Pick<TrevizeThread, "environmentId" | "runtimeThreadId">,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const saved = (yield* SubscriptionRef.get(registry.entries)).values();
    const target = resolveMyTaskTarget(task, current.environments, saved);
    switch (target._tag) {
      case "Unavailable":
        return yield* new TrevizeApiError({
          reason: "request",
          message: target.reason,
        });
      case "Saved":
        if (target.sleeping) yield* wake(target.environmentId);
        return {
          environmentId: target.environmentId,
          threadId: target.threadId,
        };
      case "Connect": {
        const loaded = yield* loadConfig;
        if (Option.isNone(loaded)) {
          return yield* new TrevizeApiError({
            reason: "unauthorized",
            message: "Sign in to Trevize Cloud to open this task.",
          });
        }
        const environmentId = yield* connect(loaded.value.config, target.environment);
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

  /**
   * The workspace with all of `repositoryIds` connected, the default one first.
   * Trusts a match the last sync saw; otherwise lists repositories again, since
   * the user may have just connected one.
   */
  const workspaceForRepositories = Effect.fn("TrevizeCloudSync.workspaceForRepositories")(
    function* (
      config: TrevizeApiConfig,
      settingsWorkspaceId: string | null,
      repositoryIds: ReadonlyArray<string>,
    ) {
      const place = (current: TrevizeCloudSyncState) =>
        placeRepositories({
          preferredWorkspaceId: settingsWorkspaceId,
          spaceWorkspaceIds: current.spaceWorkspaceIds,
          connectedRepositories: current.connectedRepositories,
          repositoryIds,
        });
      const synced = place(yield* SubscriptionRef.get(state));
      if (synced === null) {
        return yield* new TrevizeApiError({
          reason: "request",
          message: "None of your Trevize workspaces has cloud environments enabled.",
        });
      }
      if (synced._tag === "Connected") return synced.workspaceId;

      const { spaceWorkspaceIds } = yield* SubscriptionRef.get(state);
      const listed = yield* Effect.forEach(
        spaceWorkspaceIds,
        (workspaceId) =>
          listRepositories(config, workspaceId).pipe(
            Effect.provideContext(context),
            Effect.map((repositories) => [
              [workspaceId, connectedRepositoryKeys(repositories)] as const,
            ]),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: "unbounded" },
      );
      const fresh = yield* SubscriptionRef.updateAndGet(state, (current) => ({
        ...current,
        connectedRepositories: new Map([...current.connectedRepositories, ...listed.flat()]),
      }));
      const placement = place(fresh) ?? synced;
      // Unknown: some listing failed; let Trevize decide in the default workspace.
      if (placement._tag !== "NotConnected") return placement.workspaceId;
      const workspace = fresh.workspaces.find(
        (candidate) => candidate.id === placement.workspaceId,
      );
      return yield* new TrevizeRepositoryNotConnectedError({
        repositoryIds,
        connectUrl: workspace ? connectRepositoriesUrl(config.baseUrl, workspace.slug) : null,
      });
    },
  );

  const createSpace = Effect.fn("TrevizeCloudSync.createSpace")(function* (
    input: CreateSpaceInput,
  ) {
    const { config, settings } = yield* requireConfig("create a space");
    const workspaceId =
      input.workspaceId ??
      (yield* workspaceForRepositories(config, settings.workspaceId, input.repositoryIds));
    const space = yield* createTrevizeSpace(config, {
      ...input,
      workspaceId,
    }).pipe(Effect.provideContext(context));
    yield* SubscriptionRef.update(state, (latest) => ({
      ...latest,
      spaces: [space, ...latest.spaces.filter((candidate) => candidate.id !== space.id)],
    }));
    return space;
  });

  const updateSpace = Effect.fn("TrevizeCloudSync.updateSpace")(function* (
    spaceId: string,
    patch: TrevizeSpacePatch,
  ) {
    const { config } = yield* requireConfig("change this space");
    const space = yield* updateTrevizeSpace(config, spaceId, patch).pipe(
      Effect.provideContext(context),
    );
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      spaces: current.spaces.map((candidate) => (candidate.id === space.id ? space : candidate)),
    }));
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

  const listSpaceMembers = Effect.fn("TrevizeCloudSync.listSpaceMembers")(function* (
    spaceId: string,
  ) {
    const { config } = yield* requireConfig("see this space's members");
    return yield* listTrevizeSpaceMembers(config, spaceId).pipe(Effect.provideContext(context));
  });

  const listWorkspaceMembers = Effect.fn("TrevizeCloudSync.listWorkspaceMembers")(function* (
    workspaceId: string,
  ) {
    const { config } = yield* requireConfig("see your workspace's members");
    return yield* listTrevizeWorkspaceMembers(config, workspaceId).pipe(
      Effect.provideContext(context),
    );
  });

  const setSpaceMember = Effect.fn("TrevizeCloudSync.setSpaceMember")(function* (input: {
    readonly spaceId: string;
    readonly userId: string;
    readonly role: TrevizeSpaceRole;
  }) {
    const { config } = yield* requireConfig("change this space's members");
    const member = yield* setTrevizeSpaceMember(
      config,
      input.spaceId,
      input.userId,
      input.role,
    ).pipe(Effect.provideContext(context));
    yield* syncNow;
    return member;
  });

  const removeSpaceMember = Effect.fn("TrevizeCloudSync.removeSpaceMember")(function* (input: {
    readonly spaceId: string;
    readonly userId: string;
    readonly leaving: boolean;
  }) {
    const { config } = yield* requireConfig("change this space's members");
    yield* removeTrevizeSpaceMember(config, input.spaceId, input.userId).pipe(
      Effect.provideContext(context),
    );
    if (input.leaving) {
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        spaces: current.spaces.filter((space) => space.id !== input.spaceId),
      }));
    }
    yield* syncNow;
  });

  const launchSession = Effect.fn("TrevizeCloudSync.launchSession")(function* (
    input: LaunchSessionInput,
  ) {
    const { config, settings } = yield* requireConfig("start a cloud session");
    input.onPhase?.("creating");
    const workspaceId = yield* workspaceForRepositories(config, settings.workspaceId, [
      input.repository,
    ]);
    const environment = yield* createTrevizeEnvironment(config, {
      workspaceId,
      repositoryIds: [input.repository],
      title: cloudSessionTitle(input.prompt),
    }).pipe(Effect.provideContext(context));
    input.onPhase?.("starting");
    const environmentId = yield* connect(config, environment);
    // Known before the next sync, so a new thread opened meanwhile never lands here.
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      sessionEnvironments: new Map([...current.sessionEnvironments, [environmentId, environment]]),
    }));
    input.onPhase?.("starting-agent");
    const dispatched = yield* dispatchThread(config, environment.id, {
      repositoryId: input.repository,
      prompt: input.prompt,
      ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
      ...(input.model ? { model: input.model } : {}),
      dispatchKey: `cloud-session:${environment.id}`,
      ...(input.branch ? { branch: input.branch } : {}),
      // The sandbox is this session's alone, so the agent works in the checkout itself.
      worktree: false,
    }).pipe(Effect.provideContext(context));
    // The agent runs: hand it what the user sent meanwhile, in order. A failed
    // send keeps the rest for the caller instead of failing a started session.
    const unsent: Array<string> = [];
    for (
      let batch = input.takeQueued?.() ?? [];
      batch.length > 0;
      batch = input.takeQueued?.() ?? []
    ) {
      for (const prompt of batch) {
        const sent =
          unsent.length === 0 &&
          (yield* sendThreadMessage(config, dispatched.threadId, prompt).pipe(
            Effect.provideContext(context),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ));
        if (!sent) unsent.push(prompt);
      }
    }
    yield* syncNow;
    const launched: LaunchedSession = {
      environmentId,
      threadId: dispatched.threadId,
      unsent,
    };
    return launched;
  });

  const archiveSession = Effect.fn("TrevizeCloudSync.archiveSession")(function* (
    environmentId: EnvironmentId,
  ) {
    const environment = (yield* SubscriptionRef.get(state)).sessionEnvironments.get(environmentId);
    if (environment === undefined) return;
    const { config } = yield* requireConfig("archive this cloud session");
    // The sandbox stops now; reconnecting meanwhile would only wake it again.
    yield* registry.setRetriesPaused(environmentId, true);
    yield* archiveEnvironment(config, environment.id).pipe(
      Effect.provideContext(context),
      Effect.tapError(() => registry.setRetriesPaused(environmentId, false)),
    );
    yield* SubscriptionRef.update(state, (current) => {
      const sessionEnvironments = new Map(current.sessionEnvironments);
      sessionEnvironments.delete(environmentId);
      const sleeping = new Map(current.sleeping);
      sleeping.delete(environmentId);
      return { ...current, sessionEnvironments, sleeping };
    });
    // The next sync would remove it too, since Trevize no longer lists it.
    yield* registry.remove(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove an archived Trevize environment.", {
          environmentId,
          error,
        }),
      ),
    );
    yield* syncNow;
  });

  /**
   * Polls Trevize for saved environments it is starting (woken by the gateway,
   * another device or Trevize itself; this device's own wakes poll `wake`).
   * Once one runs, its connection is retried right away instead of waiting
   * out the connection backoff.
   */
  const pollStartProgress = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const starting = [...current.progress].filter(
      ([environmentId, entry]) =>
        isTrevizeStartInFlight(entry) && !current.waking.has(environmentId),
    );
    if (starting.length === 0) return;
    const loaded = yield* loadConfig;
    if (Option.isNone(loaded)) return;
    const saved = [...(yield* SubscriptionRef.get(registry.entries)).values()];
    yield* Effect.forEach(
      starting,
      ([environmentId]) =>
        Effect.gen(function* () {
          const listed = current.environments.find(
            (candidate) =>
              findSavedTrevizeEnvironment(saved, candidate.httpBaseUrl) === environmentId,
          );
          if (listed === undefined) return;
          const environment = yield* getEnvironment(loaded.value.config, listed.id).pipe(
            Effect.provideContext(context),
          );
          const entry = startProgressFromEnvironment(environment);
          yield* setProgress(environmentId, entry);
          if (entry === null) {
            yield* resumeRetries([environmentId]);
            yield* syncNow;
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("Could not refresh a Trevize environment's start.", {
              environmentId,
              error,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(START_PROGRESS_INTERVAL);
      yield* pollStartProgress;
    }
  }).pipe(Effect.forkScoped);

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
    updateSpace,
    archiveSpace,
    listSpaceMembers,
    listWorkspaceMembers,
    setSpaceMember,
    removeSpaceMember,
    launchSession,
    archiveSession,
  });
});

export const layer = Layer.effect(TrevizeCloudSync, make());
