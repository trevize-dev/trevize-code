import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Client for the Trevize public API (`/api/v1`). Trevize runs T3 servers in
 * cloud sandboxes and acts as a trusted broker: `connect` returns a one-time
 * pairing token that the client redeems against the environment with the
 * ordinary pairing flow (see `./connect.ts`).
 */

export const DEFAULT_TREVIZE_API_URL = "https://app.trevize.dev";

export interface TrevizeApiConfig {
  /** Trevize app origin, e.g. `https://app.trevize.dev`. */
  readonly baseUrl: string;
  /** A Trevize API key (`tvz_…`). */
  readonly apiKey: string;
}

export const TrevizeWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
export type TrevizeWorkspace = typeof TrevizeWorkspace.Type;

export const TrevizeRepository = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  fullName: Schema.String,
  private: Schema.Boolean,
});
export type TrevizeRepository = typeof TrevizeRepository.Type;

export const TrevizeEnvironmentStatus = Schema.Literals([
  "provisioning",
  "starting",
  "running",
  "stopped",
  "failed",
  "archived",
]);
export type TrevizeEnvironmentStatus = typeof TrevizeEnvironmentStatus.Type;

export const TrevizeEnvironment = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  title: Schema.NullOr(Schema.String),
  status: TrevizeEnvironmentStatus,
  /** What runs in the sandbox, `"trevize-code"` today; absent on older servers. */
  runtime: Schema.optional(Schema.String),
  repositoryIds: Schema.Array(Schema.String),
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  /** The space this environment runs for; absent on servers without spaces. */
  spaceId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type TrevizeEnvironment = typeof TrevizeEnvironment.Type;

/**
 * A thread Trevize launched in one of its environments (`GET /threads`).
 * `environmentId` is the Trevize environment id, not the T3 server's.
 * Decoded tolerantly: kinds and statuses are open strings, and the live
 * thread status fields are optional until Trevize reports them.
 */
export const TrevizeThread = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  environmentTitle: Schema.optional(Schema.NullOr(Schema.String)),
  environmentStatus: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceId: Schema.optional(Schema.String),
  runtimeThreadId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  sourceKind: Schema.String,
  sourceRef: Schema.optional(Schema.NullOr(Schema.String)),
  sourceUrl: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  deepLinkUrl: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  waiting: Schema.optional(Schema.NullOr(Schema.Boolean)),
  pendingRuntimeRequest: Schema.optional(Schema.Unknown),
  archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type TrevizeThread = typeof TrevizeThread.Type;

/**
 * A space (`GET /spaces`): an orchestrator chat plus the environments it runs
 * agents in, all sharing a `/shared` volume. `orchestratorThreadId` is a
 * Trevize thread id, null until Trevize has launched the orchestrator (it
 * does so in the background after the space is created).
 */
export const TrevizeSpace = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  repositoryIds: Schema.Array(Schema.String),
  orchestratorThreadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** Absent on servers from before the sandbox limit. */
  maxEnvironments: Schema.optional(Schema.Number),
});
export type TrevizeSpace = typeof TrevizeSpace.Type;

const TrevizeConnectReady = Schema.Struct({
  status: Schema.Literal("ready"),
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.String,
  pairingUrl: Schema.String,
  expiresAt: Schema.String,
  label: Schema.String,
});
export type TrevizeConnectReady = typeof TrevizeConnectReady.Type;

const TrevizeConnectStarting = Schema.Struct({
  status: Schema.Literal("starting"),
  retryAfterSeconds: Schema.Number,
});

/** Answered for a recently failed environment; connecting again after `retryAfterSeconds` retries the start. */
const TrevizeConnectFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  retryAfterSeconds: Schema.optional(Schema.Number),
});

/**
 * `wake` answers with the environment's progress and never a pairing token.
 * `ready`/`running` mean it is up; unknown statuses are treated as starting.
 */
const TrevizeWakeResult = Schema.Struct({
  status: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

const TrevizeConnectResult = Schema.Union([
  TrevizeConnectReady,
  TrevizeConnectStarting,
  TrevizeConnectFailed,
]);
export type TrevizeConnectResult = typeof TrevizeConnectResult.Type;

const WorkspacesResponse = Schema.Struct({
  items: Schema.Array(TrevizeWorkspace),
});
const RepositoriesResponse = Schema.Struct({
  items: Schema.Array(TrevizeRepository),
});
const EnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(TrevizeEnvironment),
});
const ThreadsResponse = Schema.Struct({
  threads: Schema.Array(TrevizeThread),
});
const SpacesResponse = Schema.Struct({
  spaces: Schema.Array(TrevizeSpace),
});
/** Both the public-API auth middleware (`{ error: { message } }`) and oRPC (`{ message }`) shapes. */
const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

export class TrevizeApiError extends Schema.TaggedError<TrevizeApiError>()("TrevizeApiError", {
  reason: Schema.Literals(["unauthorized", "network", "request", "decode", "timeout", "failed"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export function normalizeTrevizeBaseUrl(value: string): string {
  const trimmed = value.trim() || DEFAULT_TREVIZE_API_URL;
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return url.origin;
}

function apiUrl(config: TrevizeApiConfig, path: string): string {
  return `${normalizeTrevizeBaseUrl(config.baseUrl)}/api/v1${path}`;
}

const decodeErrorBody = Schema.decodeUnknownEffect(ErrorBody);

const failureFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(decodeErrorBody),
    Effect.map((body) => body.error?.message ?? body.message ?? null),
    Effect.orElseSucceed(() => null),
    Effect.flatMap((detail) =>
      Effect.fail(
        new TrevizeApiError({
          reason: response.status === 401 || response.status === 403 ? "unauthorized" : "request",
          status: response.status,
          message: detail ?? `Trevize answered with HTTP ${response.status}.`,
        }),
      ),
    ),
  );

/** Sends an authenticated request; any HTTP status is a success here. */
const send = (config: TrevizeApiConfig, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        request.pipe(
          HttpClientRequest.bearerToken(config.apiKey.trim()),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        // Trevize's CORS policy does not allow `traceparent`/`b3`, so a
        // propagated trace header would fail the browser preflight.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(
          (cause) =>
            new TrevizeApiError({
              reason: "network",
              message: `Could not reach Trevize: ${cause.message}`,
            }),
        ),
      );
  });

const decodeResponse = <S extends Schema.Constraint>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      (cause) =>
        new TrevizeApiError({
          reason: "decode",
          status: response.status,
          message: `Unexpected response from Trevize: ${cause.message}`,
        }),
    ),
  );

const execute = <S extends Schema.Constraint>(
  config: TrevizeApiConfig,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const response = yield* send(config, request);
    if (response.status < 200 || response.status >= 300) {
      return yield* failureFromResponse(response);
    }
    return yield* decodeResponse(response, schema);
  });

export const listWorkspaces = Effect.fn("clientRuntime.trevize.listWorkspaces")(function* (
  config: TrevizeApiConfig,
) {
  const body = yield* execute(
    config,
    HttpClientRequest.get(apiUrl(config, "/workspaces")),
    WorkspacesResponse,
  );
  return body.items;
});

export const listRepositories = Effect.fn("clientRuntime.trevize.listRepositories")(function* (
  config: TrevizeApiConfig,
  workspaceId: string,
) {
  const body = yield* execute(
    config,
    HttpClientRequest.get(
      apiUrl(config, `/workspaces/${encodeURIComponent(workspaceId)}/repositories`),
    ),
    RepositoriesResponse,
  );
  return body.items;
});

export const listEnvironments = Effect.fn("clientRuntime.trevize.listEnvironments")(function* (
  config: TrevizeApiConfig,
  workspaceId: string,
) {
  const body = yield* execute(
    config,
    HttpClientRequest.get(apiUrl(config, "/environments")).pipe(
      HttpClientRequest.setUrlParam("workspaceId", workspaceId),
    ),
    EnvironmentsResponse,
  );
  return body.environments;
});

export const createEnvironment = Effect.fn("clientRuntime.trevize.createEnvironment")(function* (
  config: TrevizeApiConfig,
  input: {
    readonly workspaceId: string;
    readonly repositoryIds: ReadonlyArray<string>;
    readonly title?: string;
  },
) {
  const title = input.title?.trim();
  return yield* execute(
    config,
    HttpClientRequest.post(apiUrl(config, "/environments")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        workspaceId: input.workspaceId,
        repositoryIds: input.repositoryIds,
        ...(title ? { title } : {}),
      }),
    ),
    TrevizeEnvironment,
  );
});

export const stopEnvironment = Effect.fn("clientRuntime.trevize.stopEnvironment")(function* (
  config: TrevizeApiConfig,
  environmentId: string,
) {
  return yield* execute(
    config,
    HttpClientRequest.post(
      apiUrl(config, `/environments/${encodeURIComponent(environmentId)}/stop`),
    ),
    TrevizeEnvironment,
  );
});

/** One `connect` call. Wakes a stopped environment and may answer `starting`. */
const requestConnect = Effect.fn("clientRuntime.trevize.requestConnect")(function* (
  config: TrevizeApiConfig,
  environmentId: string,
) {
  return yield* execute(
    config,
    HttpClientRequest.post(
      apiUrl(config, `/environments/${encodeURIComponent(environmentId)}/connect`),
    ),
    TrevizeConnectResult,
  );
});

/** Long enough for a cold sandbox to clone its repositories and start T3. */
const DEFAULT_CONNECT_MAX_WAIT_MS = 5 * 60_000;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 15;
/** Used when `wake` answers a non-final status without `retryAfterSeconds`. */
const DEFAULT_WAKE_RETRY_SECONDS = 2;

/**
 * Calls `connect` until the environment is ready, honouring `retryAfterSeconds`
 * (clamped to 1–15s), and fails with a `timeout` error once `maxWaitMs` would
 * be exceeded.
 */
export const connectWhenReady = Effect.fn("clientRuntime.trevize.connectWhenReady")(function* (
  config: TrevizeApiConfig,
  environmentId: string,
  options?: { readonly maxWaitMs?: number },
) {
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_CONNECT_MAX_WAIT_MS;
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const result = yield* requestConnect(config, environmentId);
    if (result.status === "ready") {
      return result;
    }
    if (result.status === "failed") {
      return yield* new TrevizeApiError({
        reason: "failed",
        message: result.error
          ? `The Trevize environment failed to start: ${result.error}`
          : "The Trevize environment failed to start. Try connecting again in a minute.",
      });
    }
    const delayMs =
      Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, result.retryAfterSeconds)) * 1000;
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    if (elapsedMs + delayMs > maxWaitMs) {
      return yield* new TrevizeApiError({
        reason: "timeout",
        message: "The Trevize environment is still starting. Try connecting again in a minute.",
      });
    }
    yield* Effect.sleep(Duration.millis(delayMs));
  }
});

/**
 * Calls `wake` until the environment is running, like `connectWhenReady` but
 * without minting a pairing token: the client's saved credential still works.
 * Servers without `wake` (HTTP 404) fall back to `connectWhenReady`, whose
 * token is dropped.
 */
export const wakeWhenReady = Effect.fn("clientRuntime.trevize.wakeWhenReady")(function* (
  config: TrevizeApiConfig,
  environmentId: string,
  options?: { readonly maxWaitMs?: number },
) {
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_CONNECT_MAX_WAIT_MS;
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const result = yield* execute(
      config,
      HttpClientRequest.post(
        apiUrl(config, `/environments/${encodeURIComponent(environmentId)}/wake`),
      ),
      TrevizeWakeResult,
    ).pipe(
      Effect.map(Option.some),
      // An older Trevize without `wake`.
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(result)) {
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      yield* connectWhenReady(config, environmentId, {
        maxWaitMs: Math.max(0, maxWaitMs - elapsedMs),
      });
      return;
    }
    const wake = result.value;
    if (wake.status === "ready" || wake.status === "running") return;
    if (wake.status === "failed") {
      return yield* new TrevizeApiError({
        reason: "failed",
        message: wake.error
          ? `The Trevize environment failed to start: ${wake.error}`
          : "The Trevize environment failed to start. Try waking it again in a minute.",
      });
    }
    const delayMs =
      Math.min(
        MAX_RETRY_SECONDS,
        Math.max(MIN_RETRY_SECONDS, wake.retryAfterSeconds ?? DEFAULT_WAKE_RETRY_SECONDS),
      ) * 1000;
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    if (elapsedMs + delayMs > maxWaitMs) {
      return yield* new TrevizeApiError({
        reason: "timeout",
        message: "The Trevize environment is still starting. Try again in a minute.",
      });
    }
    yield* Effect.sleep(Duration.millis(delayMs));
  }
});

/**
 * Every thread Trevize launched in one workspace, newest first. Spaces group
 * them by their environment's `spaceId`.
 */
export const listWorkspaceThreads = Effect.fn("clientRuntime.trevize.listWorkspaceThreads")(
  function* (config: TrevizeApiConfig, workspaceId: string) {
    const body = yield* execute(
      config,
      HttpClientRequest.get(apiUrl(config, "/threads")).pipe(
        HttpClientRequest.setUrlParam("workspaceId", workspaceId),
      ),
      ThreadsResponse,
    );
    return body.threads;
  },
);

/**
 * The workspace's spaces, or none when spaces are unavailable to it: Trevize
 * answers 404 unless the workspace has the `environments` flag, and older servers do
 * not know the route at all.
 */
export const listSpaces = Effect.fn("clientRuntime.trevize.listSpaces")(function* (
  config: TrevizeApiConfig,
  workspaceId: string,
) {
  return yield* execute(
    config,
    HttpClientRequest.get(apiUrl(config, "/spaces")).pipe(
      HttpClientRequest.setUrlParam("workspaceId", workspaceId),
    ),
    SpacesResponse,
  ).pipe(
    Effect.map((body) => body.spaces),
    Effect.asSome,
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeedNone,
    ),
  );
});

export interface TrevizeOrchestratorModel {
  /** A T3 provider driver kind, e.g. `codex`. */
  readonly provider: string;
  readonly model: string;
}

export interface TrevizeSpaceInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions?: string;
  /** `owner/repo` slugs or Trevize repository ids. */
  readonly repositoryIds: ReadonlyArray<string>;
  /** Most sandboxes the space runs at once, 1–32. */
  readonly maxEnvironments?: number;
  /** The orchestrator's model; Trevize launches it with the space. */
  readonly orchestratorModel?: TrevizeOrchestratorModel | null;
}

/** Creates a space. Trevize launches its orchestrator in the background. */
export const createSpace = Effect.fn("clientRuntime.trevize.createSpace")(function* (
  config: TrevizeApiConfig,
  input: TrevizeSpaceInput,
) {
  const instructions = input.instructions?.trim();
  return yield* execute(
    config,
    HttpClientRequest.post(apiUrl(config, "/spaces")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        repositoryIds: input.repositoryIds,
        ...(instructions ? { instructions } : {}),
        ...(input.maxEnvironments === undefined ? {} : { maxEnvironments: input.maxEnvironments }),
        ...(input.orchestratorModel
          ? {
              orchestrator: {
                provider: input.orchestratorModel.provider,
                model: input.orchestratorModel.model,
              },
            }
          : {}),
      }),
    ),
    TrevizeSpace,
  );
});

export const archiveSpace = Effect.fn("clientRuntime.trevize.archiveSpace")(function* (
  config: TrevizeApiConfig,
  spaceId: string,
) {
  return yield* execute(
    config,
    HttpClientRequest.post(apiUrl(config, `/spaces/${encodeURIComponent(spaceId)}/archive`)),
    TrevizeSpace,
  );
});
