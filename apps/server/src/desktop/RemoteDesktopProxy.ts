import { AuthTerminalOperateScope, REMOTE_DESKTOP_ROUTE_PREFIX } from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as DeviceHubProxy from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as RemoteDesktopService from "./RemoteDesktopService.ts";

// Only voxl's viewer page, static assets, health probe, and stream socket are exposed;
// agent-only endpoints (files/*, record*, screenshot, wait) stay closed.
const ALLOWED_HTTP_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/index.html",
  "/client.js",
  "/worker.js",
  "/audio.js",
  "/mic.js",
  "/favicon.ico",
  "/inter.woff2",
  "/healthz",
]);

// voxl's own login leaves these open: the page requests them without the query string that
// carries the wsTicket (`<script src="client.js">`, its font and favicon), so they cannot need one.
const PUBLIC_HTTP_PATHS: ReadonlySet<string> = new Set([
  "/client.js",
  "/worker.js",
  "/audio.js",
  "/mic.js",
  "/favicon.ico",
  "/inter.woff2",
  "/healthz",
]);

const ALLOWED_WS_PATHS: ReadonlySet<string> = new Set(["/ws"]);

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "x-forwarded-proto",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyWebSocket = Effect.fn("RemoteDesktopProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  headers: Readonly<Record<string, string>>,
) {
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    headers: { ...headers },
  }).pipe(Effect.provide(DeviceHubProxy.upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(
    Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
    Effect.ignoreCause,
  );
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("RemoteDesktopProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  invalidated: Effect.Effect<void>,
  extraHeaders: Readonly<Record<string, string>>,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders({
      ...forwardHeaders(request, new URL(upstreamUrl).origin),
      ...extraHeaders,
    }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      name === "content-encoding" ||
      name === "transfer-encoding" ||
      name === "connection" ||
      name === "set-cookie"
    ) {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  headers["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(invalidated)), {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const desktopPath = url.value.pathname.slice(REMOTE_DESKTOP_ROUTE_PREFIX.length) || "/";
  const upgrade = isWebSocketUpgrade(request);
  const publicAsset = !upgrade && PUBLIC_HTTP_PATHS.has(desktopPath);
  const session = publicAsset ? null : yield* authenticateMediaRequest(AuthTerminalOperateScope);
  const allowed = upgrade ? ALLOWED_WS_PATHS.has(desktopPath) : ALLOWED_HTTP_PATHS.has(desktopPath);
  if (!allowed) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (!upgrade && request.method !== "GET" && request.method !== "HEAD") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const sessions = yield* SessionStore.SessionStore;
  const invalidated =
    session === null
      ? Effect.never
      : sessions.awaitInvalidation(session.sessionId).pipe(
          Effect.catchTags({
            SessionCredentialVerificationError: (error) =>
              failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
          }),
        );
  const remoteDesktop = yield* RemoteDesktopService.RemoteDesktopService;
  const endpoint = yield* remoteDesktop.currentEndpoint;
  if (Option.isNone(endpoint)) {
    return HttpServerResponse.text("Remote desktop is not running", { status: 503 });
  }
  const upstreamOrigin = `http://127.0.0.1:${endpoint.value.port}`;
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("wsTicket");
  upstreamSearch.delete("dpop");
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  const upstreamUrl = `${upstreamOrigin}${desktopPath}${search}`;
  const authHeader = `Bearer ${Redacted.value(endpoint.value.password)}`;
  if (upgrade) {
    const wsHeaders: Record<string, string> = {
      authorization: authHeader,
      ...(request.headers.origin !== undefined ? { origin: upstreamOrigin } : {}),
    };
    return yield* Effect.raceFirst(
      proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), wsHeaders),
      invalidated.pipe(Effect.as(HttpServerResponse.empty())),
    );
  }
  return yield* proxyHttp(request, upstreamUrl, invalidated, { authorization: authHeader });
});

export const layer = HttpRouter.add("*", `${REMOTE_DESKTOP_ROUTE_PREFIX}/*`, handler);
