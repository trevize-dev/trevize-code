import type { ComposerContextRecord, OrchestrationMessageContext } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TrevizeEnvironment, TrevizeSpace, TrevizeThread } from "./api.ts";

/**
 * Agent updates: Trevize delivers a sub-agent's progress to its space's
 * orchestrator thread, and the orchestrator's messages to an agent, as
 * ordinary user messages carrying one `trevize-agent` context record. Upstream
 * t3 keeps the record as an unknown kind; clients that know it draw the
 * message as a notification instead of a user bubble.
 */

export const TREVIZE_AGENT_CONTEXT_KIND = "trevize-agent";

export const TrevizeAgentUpdateEvent = Schema.Literals([
  "completed",
  "failed",
  "waiting",
  "pull_request",
  "message",
]);
export type TrevizeAgentUpdateEvent = typeof TrevizeAgentUpdateEvent.Type;

export const TrevizeAgentUpdatePayload = Schema.Struct({
  v: Schema.Literal(1),
  direction: Schema.Literals(["to-orchestrator", "to-agent"]),
  /** The other party: the agent for `to-orchestrator`, the orchestrator for `to-agent`. */
  thread: Schema.Struct({
    id: Schema.String,
    environmentId: Schema.String,
    t3ThreadId: Schema.String,
    title: Schema.NullOr(Schema.String),
  }),
  event: TrevizeAgentUpdateEvent,
  summary: Schema.String,
  detail: Schema.optional(Schema.String),
  pullRequestUrl: Schema.optional(Schema.String),
});
export type TrevizeAgentUpdatePayload = typeof TrevizeAgentUpdatePayload.Type;

export interface TrevizeAgentUpdate {
  readonly contextId: string;
  readonly direction: TrevizeAgentUpdatePayload["direction"];
  readonly thread: TrevizeAgentUpdatePayload["thread"];
  /** The other party's display title: its thread title, else the record label. */
  readonly title: string;
  readonly event: TrevizeAgentUpdateEvent;
  readonly summary: string;
  readonly detail: string | null;
  /** Only http(s) URLs, so the link is safe to render. */
  readonly pullRequestUrl: string | null;
}

const decodePayload = Schema.decodeUnknownOption(TrevizeAgentUpdatePayload);

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function httpUrl(value: string | undefined): string | null {
  const trimmed = nonBlank(value);
  if (trimmed === null) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The typed update behind a `trevize-agent` record, or null for any other or malformed record. */
export function decodeTrevizeAgentRecord(record: ComposerContextRecord): TrevizeAgentUpdate | null {
  if (record.kind !== TREVIZE_AGENT_CONTEXT_KIND || !("payload" in record)) return null;
  const decoded = decodePayload(record.payload);
  if (Option.isNone(decoded)) return null;
  const payload = decoded.value;
  return {
    contextId: record.contextId,
    direction: payload.direction,
    thread: payload.thread,
    title:
      nonBlank(payload.thread.title) ??
      nonBlank(record.label) ??
      (payload.direction === "to-agent" ? "Orchestrator" : "Agent"),
    event: payload.event,
    summary: payload.summary.trim(),
    detail: nonBlank(payload.detail),
    pullRequestUrl: httpUrl(payload.pullRequestUrl),
  };
}

/** The agent update a message carries, or null for an ordinary message. */
export function trevizeAgentUpdateOf(message: {
  readonly context?: OrchestrationMessageContext | undefined;
}): TrevizeAgentUpdate | null {
  for (const record of message.context?.records ?? []) {
    const update = decodeTrevizeAgentRecord(record);
    if (update !== null) return update;
  }
  return null;
}

/** Where clicking the other party's name goes. */
export type TrevizeAgentUpdateTarget =
  | {
      /** The thread belongs to the space on screen: activate its tab (`null` is the space chat). */
      readonly _tag: "SpaceTab";
      readonly spaceId: string;
      readonly tab: string | null;
    }
  | {
      readonly _tag: "OpenThread";
      readonly thread: Pick<TrevizeThread, "id" | "environmentId" | "t3ThreadId">;
    };

export function trevizeAgentUpdateTarget(input: {
  readonly thread: TrevizeAgentUpdate["thread"];
  /** The space whose route is on screen, if any. */
  readonly activeSpace: Pick<TrevizeSpace, "id" | "orchestratorThreadId"> | null;
  readonly environments: ReadonlyArray<Pick<TrevizeEnvironment, "id" | "spaceId">>;
}): TrevizeAgentUpdateTarget {
  const { thread, activeSpace } = input;
  const spaceId =
    input.environments.find((environment) => environment.id === thread.environmentId)?.spaceId ??
    null;
  if (activeSpace !== null && spaceId === activeSpace.id) {
    return {
      _tag: "SpaceTab",
      spaceId: activeSpace.id,
      tab: thread.id === activeSpace.orchestratorThreadId ? null : thread.id,
    };
  }
  return {
    _tag: "OpenThread",
    thread: { id: thread.id, environmentId: thread.environmentId, t3ThreadId: thread.t3ThreadId },
  };
}
