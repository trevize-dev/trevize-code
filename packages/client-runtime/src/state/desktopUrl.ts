import { REMOTE_DESKTOP_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { mintMediaTicket } from "./deviceHubAccess.ts";

/**
 * Builds the environment's `/api/desktop/` viewer URL. Always ends with a trailing slash so
 * voxl's relative asset, worker, and WebSocket URLs resolve under `/api/desktop/`.
 */
export function buildRemoteDesktopUrl(input: {
  readonly httpBaseUrl: string;
  readonly ticket?: string | null | undefined;
}): string {
  const url = new URL(environmentEndpointUrl(input.httpBaseUrl, `${REMOTE_DESKTOP_ROUTE_PREFIX}/`));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported remote desktop URL protocol: ${url.protocol}`);
  }
  const ticket = input.ticket?.trim();
  if (ticket) {
    url.searchParams.set("wsTicket", ticket);
  }
  return url.toString();
}

/**
 * Resolves the remote desktop viewer URL for a connection. Cookie-only same-origin connections use
 * the bare `/api/desktop/` URL; bearer and DPoP connections mint a reusable media ticket.
 */
export const resolveRemoteDesktopUrl = Effect.fn("clientRuntime.state.resolveRemoteDesktopUrl")(
  function* (
    prepared: PreparedConnection,
  ): Effect.fn.Return<string, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    if (prepared.httpAuthorization === null) {
      return buildRemoteDesktopUrl({ httpBaseUrl: prepared.httpBaseUrl });
    }
    const ticket = yield* mintMediaTicket(prepared);
    return buildRemoteDesktopUrl({
      httpBaseUrl: prepared.httpBaseUrl,
      ticket: Redacted.value(ticket.ticket),
    });
  },
);
