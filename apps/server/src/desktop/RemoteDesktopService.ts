import { RemoteDesktopError, type RemoteDesktopPrepareResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const RemoteDesktopCommandOutput = Schema.fromJsonString(
  Schema.Struct({
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    password: Schema.String.check(Schema.isNonEmpty()),
    width: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    height: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
);

const decodeCommandOutput = Schema.decodeUnknownEffect(RemoteDesktopCommandOutput);

const DEFAULT_COMMAND_TIMEOUT: Duration.Input = "60 seconds";
const DEFAULT_HEALTH_TIMEOUT: Duration.Input = "2 seconds";
const DEFAULT_HEALTH_RETRIES = 10;
const DEFAULT_HEALTH_RETRY_INTERVAL: Duration.Input = "250 millis";

export interface RemoteDesktopEndpoint {
  readonly port: number;
  readonly password: Redacted.Redacted<string>;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface RemoteDesktopServiceOptions {
  readonly healthCheckRetries?: number | undefined;
  readonly healthCheckInterval?: Duration.Input | undefined;
}

export class RemoteDesktopService extends Context.Service<
  RemoteDesktopService,
  {
    readonly prepare: Effect.Effect<RemoteDesktopPrepareResult, RemoteDesktopError>;
    readonly currentEndpoint: Effect.Effect<Option.Option<RemoteDesktopEndpoint>>;
  }
>()("t3/desktop/RemoteDesktopService") {}

const parseCommandOutput = (
  stdout: string,
): Effect.Effect<RemoteDesktopEndpoint, RemoteDesktopError> => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    return Effect.fail(new RemoteDesktopError({ reason: "start_failed" }));
  }
  return decodeCommandOutput(trimmed).pipe(
    Effect.map((decoded): RemoteDesktopEndpoint => ({
      port: decoded.port,
      password: Redacted.make(decoded.password),
      ...(decoded.width !== undefined ? { width: decoded.width } : {}),
      ...(decoded.height !== undefined ? { height: decoded.height } : {}),
    })),
    Effect.mapError(() => new RemoteDesktopError({ reason: "start_failed" })),
  );
};

export const make = Effect.fn("RemoteDesktopService.make")(function* (
  options?: RemoteDesktopServiceOptions,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const serviceScope = yield* Scope.Scope;

  const healthRetries = options?.healthCheckRetries ?? DEFAULT_HEALTH_RETRIES;
  const healthInterval = options?.healthCheckInterval ?? DEFAULT_HEALTH_RETRY_INTERVAL;

  const cachedRef = yield* Ref.make<Option.Option<RemoteDesktopEndpoint>>(Option.none());
  const inFlightRef = yield* Ref.make<
    Option.Option<Deferred.Deferred<RemoteDesktopEndpoint, RemoteDesktopError>>
  >(Option.none());

  const checkHealth = Effect.fn("RemoteDesktopService.checkHealth")(function* (port: number) {
    return yield* Effect.scoped(
      HttpClient.withScope(httpClient)
        .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/healthz`))
        .pipe(
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(Effect.as(response.status >= 200 && response.status < 300)),
          ),
        ),
    ).pipe(
      Effect.timeout(DEFAULT_HEALTH_TIMEOUT),
      Effect.orElseSucceed(() => false),
    );
  });

  const waitForHealthy = Effect.fn("RemoteDesktopService.waitForHealthy")(function* (port: number) {
    for (let attempt = 0; attempt <= healthRetries; attempt++) {
      if (yield* checkHealth(port)) return true;
      if (attempt < healthRetries) {
        yield* Effect.sleep(healthInterval);
      }
    }
    return false;
  });

  const runEnsureCommand = Effect.fn("RemoteDesktopService.runEnsureCommand")(function* (
    command: string,
  ) {
    const shellInvocation =
      platform === "win32"
        ? { command: "cmd.exe", args: ["/c", command] }
        : { command: "/bin/sh", args: ["-c", command] };
    const result = yield* processRunner
      .run({
        ...shellInvocation,
        cwd: serverConfig.cwd,
        timeout: DEFAULT_COMMAND_TIMEOUT,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Remote desktop command failed to run", { errorTag: error._tag }),
        ),
        Effect.mapError(() => new RemoteDesktopError({ reason: "start_failed" })),
      );
    // Never log stdout or stderr: stdout contains the voxl password.
    if (result.timedOut || result.code !== 0) {
      yield* Effect.logWarning("Remote desktop command exited unsuccessfully", {
        exitCode: result.code,
        timedOut: result.timedOut,
      });
      return yield* new RemoteDesktopError({ reason: "start_failed" });
    }
    return yield* parseCommandOutput(result.stdout).pipe(
      Effect.tapError(() => Effect.logWarning("Remote desktop command returned invalid JSON")),
    );
  });

  const resolveEndpoint = Effect.fn("RemoteDesktopService.resolveEndpoint")(function* (
    command: string,
  ) {
    const cached = yield* Ref.get(cachedRef);
    if (Option.isSome(cached)) {
      if (yield* checkHealth(cached.value.port)) {
        return cached.value;
      }
      yield* Ref.set(cachedRef, Option.none());
    }
    const endpoint = yield* runEnsureCommand(command);
    if (!(yield* waitForHealthy(endpoint.port))) {
      yield* Effect.logWarning("Remote desktop did not become healthy", { port: endpoint.port });
      return yield* new RemoteDesktopError({ reason: "not_ready" });
    }
    yield* Ref.set(cachedRef, Option.some(endpoint));
    return endpoint;
  });

  const prepare = Effect.fn("RemoteDesktopService.prepare")(function* () {
    const command = serverConfig.remoteDesktopCommand;
    if (!command) {
      return yield* new RemoteDesktopError({ reason: "not_configured" });
    }
    const candidate = yield* Deferred.make<RemoteDesktopEndpoint, RemoteDesktopError>();
    const { deferred, isOwner } = yield* Ref.modify(inFlightRef, (current) =>
      Option.isSome(current)
        ? [{ deferred: current.value, isOwner: false }, current]
        : [{ deferred: candidate, isOwner: true }, Option.some(candidate)],
    );
    if (isOwner) {
      yield* resolveEndpoint(command).pipe(
        Effect.onExit((exit) =>
          Ref.update(inFlightRef, (current) =>
            Option.isSome(current) && current.value === candidate ? Option.none() : current,
          ).pipe(Effect.andThen(Deferred.done(candidate, exit)), Effect.asVoid),
        ),
        Effect.ignoreCause,
        Effect.forkIn(serviceScope),
      );
    }
    yield* Deferred.await(deferred);
    return { ready: true } as const;
  });

  return RemoteDesktopService.of({
    prepare: prepare(),
    currentEndpoint: Ref.get(cachedRef),
  });
});

export const layer = Layer.effect(RemoteDesktopService, make());
