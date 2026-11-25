// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RemoteDesktopProxy from "./RemoteDesktopProxy.ts";
import * as RemoteDesktopService from "./RemoteDesktopService.ts";

interface UpstreamRequestRecord {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

const makeFakeVoxl = Effect.acquireRelease(
  Effect.promise(async () => {
    const httpRequests: UpstreamRequestRecord[] = [];
    const wsRequests: UpstreamRequestRecord[] = [];
    let healthy = true;
    const upstreamClosed = Promise.withResolvers<void>();

    const server = NodeHttp.createServer((req, res) => {
      httpRequests.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url === "/healthz") {
        res.writeHead(healthy ? 200 : 503, { "content-type": "text/plain" });
        res.end(healthy ? "ok" : "unhealthy");
        return;
      }
      res.writeHead(200, {
        "content-type": req.url === "/" ? "text/html" : "application/javascript",
        "set-cookie": "voxl=leak",
      });
      res.end(`upstream:${req.url}`);
    });

    const wss = new NodeWS.WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wsRequests.push({ method: req.method, url: req.url, headers: req.headers });
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.once("close", upstreamClosed.resolve);
        ws.send(Uint8Array.of(0x41, 0x42));
        ws.on("message", (data, binary) => ws.send(data, { binary }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Fake voxl failed to bind");
    }

    return {
      port: address.port,
      httpRequests,
      wsRequests,
      upstreamClosed: upstreamClosed.promise,
      setHealthy: (next: boolean) => {
        healthy = next;
      },
      close: async () => {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }),
  (voxl) => Effect.promise(() => voxl.close()),
);

function makeWebProxyFixture(input: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly authError?:
    | EnvironmentAuth.ServerAuthCredentialError
    | EnvironmentAuth.ServerAuthInternalError;
  readonly endpoint?: Option.Option<RemoteDesktopService.RemoteDesktopEndpoint>;
  readonly invalidated?: Promise<void>;
}) {
  const requests: Array<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: request.headers });
      return HttpClientResponse.fromWeb(
        request,
        new Response("ok", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "upstream-cookie=1",
          },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    RemoteDesktopProxy.layer.pipe(
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            input.authError
              ? Effect.fail(input.authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "user-1",
                  method: "bearer-access-token",
                  scopes: input.scopes,
                }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(RemoteDesktopService.RemoteDesktopService)({
          currentEndpoint: Effect.succeed(
            input.endpoint ??
              Option.some({
                port: 6901,
                password: Redacted.make("voxl-secret-pw"),
              }),
          ),
        }),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(
        Layer.mock(SessionStore.SessionStore, {
          cookieName: "test",
          legacyCookieName: undefined,
          awaitInvalidation: () =>
            input.invalidated ? Effect.promise(() => input.invalidated!) : Effect.never,
        }),
      ),
    ),
    { disableLogger: true },
  );
  return { handler, dispose, requests };
}

describe("RemoteDesktopProxy", () => {
  it("returns 401 when unauthenticated and never reaches upstream", async () => {
    const fixture = makeWebProxyFixture({
      scopes: [],
      authError: new EnvironmentAuth.ServerAuthMissingCredentialError({}),
    });
    try {
      const response = await fixture.handler(new Request("http://t3.test/api/desktop/"));
      expect(response.status).toBe(401);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("serves voxl's public assets without credentials, since the page requests them without its wsTicket", async () => {
    const fixture = makeWebProxyFixture({
      scopes: [],
      authError: new EnvironmentAuth.ServerAuthMissingCredentialError({}),
    });
    try {
      for (const asset of ["/client.js", "/inter.woff2", "/favicon.ico", "/worker.js"]) {
        const response = await fixture.handler(new Request(`http://t3.test/api/desktop${asset}`));
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(fixture.requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:6901/client.js",
        "http://127.0.0.1:6901/inter.woff2",
        "http://127.0.0.1:6901/favicon.ico",
        "http://127.0.0.1:6901/worker.js",
      ]);

      for (const path of ["/api/desktop/index.html", "/api/desktop/files/list"]) {
        expect((await fixture.handler(new Request(`http://t3.test${path}`))).status).toBe(401);
      }
      const upgrade = await fixture.handler(
        new Request("http://t3.test/api/desktop/ws", {
          headers: { upgrade: "websocket", connection: "Upgrade" },
        }),
      );
      expect(upgrade.status).toBe(401);
      expect(fixture.requests).toHaveLength(4);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([AuthOrchestrationReadScope, AuthTerminalReadScope])(
    "refuses sessions lacking terminal operate scope (%s)",
    async (scope) => {
      const fixture = makeWebProxyFixture({ scopes: [scope] });
      try {
        const response = await fixture.handler(
          new Request("http://t3.test/api/desktop/?wsTicket=valid-ticket"),
        );
        expect(response.status).toBe(403);
        expect(fixture.requests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each([
    "/api/desktop/files/list",
    "/api/desktop/files/home/.env",
    "/api/desktop/record/start",
    "/api/desktop/record/stop?id=1",
    "/api/desktop/screenshot",
    "/api/desktop/wait",
    "/api/desktop/stats",
  ])("refuses agent-only or unlisted path %s without proxying", async (path) => {
    const fixture = makeWebProxyFixture({ scopes: [AuthTerminalOperateScope] });
    try {
      const response = await fixture.handler(new Request(`http://t3.test${path}`));
      expect(response.status).toBe(404);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("proxies allowlisted HTTP paths, strips sensitive headers, wsTicket and dpop, and adds Bearer upstream", async () => {
    const fixture = makeWebProxyFixture({ scopes: [AuthTerminalOperateScope] });
    try {
      const response = await fixture.handler(
        new Request(
          "https://t3.example.test/api/desktop/?wsTicket=secret-ticket&dpop=query-proof&foo=1",
          {
            headers: {
              cookie: "t3_session=secret",
              authorization: "Bearer client-token",
              dpop: "dpop-proof",
              origin: "https://t3.example.test",
            },
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("ok");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.url).toBe("http://127.0.0.1:6901/?foo=1");
      expect(fixture.requests[0]?.headers.authorization).toBe("Bearer voxl-secret-pw");
      expect(fixture.requests[0]?.headers.origin).toBe("http://127.0.0.1:6901");
      expect(fixture.requests[0]?.headers.cookie).toBeUndefined();
      expect(fixture.requests[0]?.headers.dpop).toBeUndefined();

      for (const asset of [
        "/api/desktop/index.html",
        "/api/desktop/client.js",
        "/api/desktop/worker.js",
        "/api/desktop/audio.js",
        "/api/desktop/mic.js",
        "/api/desktop/favicon.ico",
        "/api/desktop/inter.woff2",
        "/api/desktop/healthz",
      ]) {
        const assetResponse = await fixture.handler(new Request(`http://t3.test${asset}`));
        expect(assetResponse.status).toBe(200);
        await assetResponse.text();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects non-GET HTTP methods and returns 503 when not yet prepared", async () => {
    const fixture = makeWebProxyFixture({
      scopes: [AuthTerminalOperateScope],
      endpoint: Option.none(),
    });
    try {
      const postRes = await fixture.handler(
        new Request("http://t3.test/api/desktop/", { method: "POST" }),
      );
      expect(postRes.status).toBe(405);
      const getRes = await fixture.handler(new Request("http://t3.test/api/desktop/"));
      expect(getRes.status).toBe(503);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it.live(
    "proxies WebSocket upgrades with Bearer password, no wsTicket or cookie, and closes on session invalidation",
    () =>
      Effect.gen(function* () {
        const voxl = yield* makeFakeVoxl;
        const invalidated = yield* Deferred.make<void>();
        const services = yield* Layer.build(
          HttpRouter.serve(RemoteDesktopProxy.layer, { disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provide(
              Layer.mock(SessionStore.SessionStore, {
                cookieName: "test",
                legacyCookieName: undefined,
                awaitInvalidation: () => Deferred.await(invalidated),
              }),
            ),
            Layer.provide(
              Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
                authenticateWebSocketUpgrade: () =>
                  Effect.succeed({
                    sessionId: AuthSessionId.make("session-ws"),
                    subject: "user-1",
                    method: "bearer-access-token",
                    scopes: [AuthTerminalOperateScope],
                  }),
              } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
            ),
            Layer.provide(
              Layer.mock(RemoteDesktopService.RemoteDesktopService)({
                currentEndpoint: Effect.succeedSome({
                  port: voxl.port,
                  password: Redacted.make("voxl-ws-secret"),
                }),
              }),
            ),
          ),
        );

        const origin = HttpServer.formatAddress(
          Context.get(services, HttpServer.HttpServer).address,
        ).replace(/^http/, "ws");
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new NodeWS.WebSocket(`${origin}/api/desktop/ws?wsTicket=client-ticket`, {
                headers: {
                  cookie: "t3_session=leaked",
                  authorization: "Bearer client-token",
                  dpop: "client-dpop",
                },
              }),
          ),
          (socket) => Effect.sync(() => socket.close()),
        );
        client.binaryType = "arraybuffer";
        const frames: number[][] = [];
        const received = Promise.withResolvers<void>();
        client.addEventListener("error", () => received.reject(new Error("WS proxy failed")));
        client.addEventListener("message", ({ data }) => {
          frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
          if (frames.length === 1) {
            client.send(Uint8Array.of(0x10, 0x20));
          } else if (frames.length === 2) {
            received.resolve();
          }
        });

        yield* Effect.promise(() => received.promise);
        expect(frames).toEqual([
          [0x41, 0x42],
          [0x10, 0x20],
        ]);
        expect(voxl.wsRequests).toHaveLength(1);
        expect(voxl.wsRequests[0]?.url).toBe("/ws");
        expect(voxl.wsRequests[0]?.headers.authorization).toBe("Bearer voxl-ws-secret");
        expect(voxl.wsRequests[0]?.headers.cookie).toBeUndefined();
        expect(voxl.wsRequests[0]?.headers.dpop).toBeUndefined();

        const closed = new Promise<void>((resolve) =>
          client.addEventListener("close", () => resolve(), { once: true }),
        );
        yield* Deferred.succeed(invalidated, undefined);
        yield* Effect.promise(() => Promise.all([closed, voxl.upstreamClosed]));
      }),
  );
});

function makeServiceTestConfigLayer(prefix: string, remoteDesktopCommand?: string) {
  const base = ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  if (remoteDesktopCommand === undefined) return base;
  return Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      remoteDesktopCommand,
    })),
  ).pipe(Layer.provide(base));
}

describe("RemoteDesktopService", () => {
  it.live("deduplicates concurrent prepares and re-runs the command after /healthz fails", () =>
    Effect.gen(function* () {
      const voxl = yield* makeFakeVoxl;
      let runCount = 0;
      const commandStarted = yield* Deferred.make<void>();
      const releaseFirstRun = yield* Deferred.make<void>();

      const service = yield* RemoteDesktopService.make({ healthCheckRetries: 0 }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeServiceTestConfigLayer("t3code-desktop-test-", "fake-desktop-ensure"),
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: () =>
                Effect.gen(function* () {
                  runCount++;
                  const currentRun = runCount;
                  if (currentRun === 1) {
                    yield* Deferred.succeed(commandStarted, undefined);
                    yield* Deferred.await(releaseFirstRun);
                  }
                  return {
                    stdout: `${JSON.stringify({
                      port: voxl.port,
                      width: 1024,
                      height: 768,
                      password: `pw-${currentRun}`,
                    })}\n`,
                    stderr: "",
                    code: 0 as ProcessRunner.ProcessRunOutput["code"],
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                }),
            }),
            FetchHttpClient.layer,
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );

      // Concurrent prepares run the command only once.
      const first = yield* Effect.forkChild(service.prepare);
      yield* Deferred.await(commandStarted);
      const second = yield* Effect.forkChild(service.prepare);
      yield* Deferred.succeed(releaseFirstRun, undefined);

      expect(yield* Fiber.join(first)).toEqual({ ready: true });
      expect(yield* Fiber.join(second)).toEqual({ ready: true });
      expect(runCount).toBe(1);
      const cached = yield* service.currentEndpoint;
      expect(Option.isSome(cached)).toBe(true);
      if (Option.isSome(cached)) {
        expect(Redacted.value(cached.value.password)).toBe("pw-1");
      }

      // Healthy cached endpoint does not re-run the command.
      expect(yield* service.prepare).toEqual({ ready: true });
      expect(runCount).toBe(1);

      // When /healthz fails, prepare clears the cache and re-runs the command.
      voxl.setHealthy(false);
      const failed = yield* service.prepare.pipe(Effect.flip);
      expect(failed._tag).toBe("RemoteDesktopError");
      expect(failed.reason).toBe("not_ready");
      expect(runCount).toBe(2);

      // Once healthy again, prepare runs and caches the fresh password.
      voxl.setHealthy(true);
      expect(yield* service.prepare).toEqual({ ready: true });
      expect(runCount).toBe(3);
      const refreshed = yield* service.currentEndpoint;
      expect(Option.isSome(refreshed)).toBe(true);
      if (Option.isSome(refreshed)) {
        expect(Redacted.value(refreshed.value.password)).toBe("pw-3");
      }
    }),
  );

  it.effect("returns not_configured when T3CODE_REMOTE_DESKTOP_COMMAND is unset", () =>
    Effect.gen(function* () {
      const service = yield* RemoteDesktopService.make({ healthCheckRetries: 0 }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeServiceTestConfigLayer("t3code-desktop-unset-"),
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: () => Effect.die("should not run"),
            }),
            FetchHttpClient.layer,
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );
      const error = yield* service.prepare.pipe(Effect.flip);
      expect(error._tag).toBe("RemoteDesktopError");
      expect(error.reason).toBe("not_configured");
    }),
  );

  it.effect("returns start_failed without leaking stdout when command output is invalid", () =>
    Effect.gen(function* () {
      const service = yield* RemoteDesktopService.make({ healthCheckRetries: 0 }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeServiceTestConfigLayer("t3code-desktop-invalid-", "bad-cmd"),
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: () =>
                Effect.succeed({
                  stdout: "not-json super-secret-password",
                  stderr: "",
                  code: 0 as ProcessRunner.ProcessRunOutput["code"],
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
            }),
            FetchHttpClient.layer,
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );
      const error = yield* service.prepare.pipe(Effect.flip);
      expect(error._tag).toBe("RemoteDesktopError");
      expect(error.reason).toBe("start_failed");
      expect(error.message).not.toContain("super-secret-password");
    }),
  );
});
