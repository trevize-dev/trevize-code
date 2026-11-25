import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "./config.ts";
import { FORWARDED_AUTHORIZATION_HEADER, layerForwardedAuthorization } from "./http.ts";

const echoAuthorization = HttpRouter.add(
  "GET",
  "/echo",
  Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
    HttpServerResponse.text(request.headers.authorization ?? "none"),
  ),
);

const serveEcho = (forwardedAuthorization: boolean) =>
  Effect.gen(function* () {
    const config = ServerConfig.ServerConfig.pipe(
      Effect.map((base) => ({ ...base, forwardedAuthorization })),
      Layer.effect(ServerConfig.ServerConfig),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-forwarded-auth-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    yield* HttpRouter.serve(
      echoAuthorization.pipe(Layer.provide(layerForwardedAuthorization), Layer.provide(config)),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.build);
    const client = yield* HttpClient.HttpClient;
    return (headers: Record<string, string>) =>
      client.get("/echo", { headers }).pipe(Effect.flatMap((response) => response.text));
  });

it.effect("restores Authorization from the forwarded header when enabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const echo = yield* serveEcho(true);
      expect(yield* echo({ [FORWARDED_AUTHORIZATION_HEADER]: "Bearer forwarded" })).toBe(
        "Bearer forwarded",
      );
      // A real Authorization header always wins.
      expect(
        yield* echo({
          authorization: "Bearer direct",
          [FORWARDED_AUTHORIZATION_HEADER]: "Bearer forwarded",
        }),
      ).toBe("Bearer direct");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("ignores the forwarded header unless enabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const echo = yield* serveEcho(false);
      expect(yield* echo({ [FORWARDED_AUTHORIZATION_HEADER]: "Bearer forwarded" })).toBe("none");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
