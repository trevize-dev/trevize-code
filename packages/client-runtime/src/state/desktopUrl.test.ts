import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { PreparedConnection } from "../connection/model.ts";
import { buildRemoteDesktopUrl, resolveRemoteDesktopUrl } from "./desktopUrl.ts";

function makePreparedConnection(
  httpBaseUrl: string,
  withAuthorization: boolean,
): PreparedConnection {
  return {
    environmentId: EnvironmentId.make("env-1"),
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    httpAuthorization: withAuthorization ? { _tag: "Bearer", token: "session-token" } : null,
    authMethod: withAuthorization ? "bearer-access-token" : "browser-session-cookie",
  } as unknown as PreparedConnection;
}

describe("remote desktop URL builder", () => {
  it("builds a bare /api/desktop/ URL without a ticket and appends wsTicket when given", () => {
    expect(buildRemoteDesktopUrl({ httpBaseUrl: "https://env.example.test" })).toBe(
      "https://env.example.test/api/desktop/",
    );
    expect(buildRemoteDesktopUrl({ httpBaseUrl: "https://env.example.test/ignored?x=1#h" })).toBe(
      "https://env.example.test/api/desktop/",
    );
    expect(buildRemoteDesktopUrl({ httpBaseUrl: "http://127.0.0.1:3773", ticket: "abc" })).toBe(
      "http://127.0.0.1:3773/api/desktop/?wsTicket=abc",
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => buildRemoteDesktopUrl({ httpBaseUrl: "javascript:alert(1)" })).toThrow();
  });

  it.effect("uses the bare URL for cookie-only connections without minting a ticket", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make(() =>
        Effect.sync(() => {
          requests++;
          throw new Error("should not mint ticket");
        }),
      );
      const url = yield* resolveRemoteDesktopUrl(
        makePreparedConnection("https://env.example.test", false),
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(url).toBe("https://env.example.test/api/desktop/");
      expect(requests).toBe(0);
    }),
  );

  it.effect("mints a media ticket and appends wsTicket for authenticated connections", () =>
    Effect.gen(function* () {
      const requestedUrls: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requestedUrls.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                ticket: Redacted.value(Redacted.make("media-ticket-123")),
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe("2026-11-25T12:00:00Z")),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );
      const url = yield* resolveRemoteDesktopUrl(
        makePreparedConnection("https://env.example.test", true),
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(url).toBe("https://env.example.test/api/desktop/?wsTicket=media-ticket-123");
      expect(requestedUrls).toEqual(["https://env.example.test/api/auth/websocket-ticket/media"]);
    }),
  );
});
