import * as Schema from "effect/Schema";

export const REMOTE_DESKTOP_ROUTE_PREFIX = "/api/desktop";

export const RemoteDesktopPrepareResult = Schema.Struct({
  ready: Schema.Literal(true),
});
export type RemoteDesktopPrepareResult = typeof RemoteDesktopPrepareResult.Type;

export const RemoteDesktopErrorReason = Schema.Literals([
  "not_configured",
  "start_failed",
  "not_ready",
]);
export type RemoteDesktopErrorReason = typeof RemoteDesktopErrorReason.Type;

export class RemoteDesktopError extends Schema.TaggedError<RemoteDesktopError>()(
  "RemoteDesktopError",
  {
    reason: RemoteDesktopErrorReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "Remote desktop is not configured on this environment.";
      case "start_failed":
        return "Failed to start the remote desktop.";
      case "not_ready":
        return "The remote desktop did not become ready.";
    }
  }
}
