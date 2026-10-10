import { describe, expect, it } from "@effect/vitest";
import { OrchestrationMessageContext } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  decodeTrevizeAgentRecord,
  trevizeAgentMessageBody,
  trevizeAgentUpdateOf,
  trevizeAgentUpdateTarget,
} from "./agentUpdates.ts";

const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

const payload = {
  v: 1,
  direction: "to-orchestrator",
  thread: {
    id: "thr_agent",
    environmentId: "env_agent",
    t3ThreadId: "t3-agent",
    title: "Fix billing webhooks",
  },
  event: "pull_request",
  summary: " opened a pull request ",
  detail: "Adds retries.\n\nTests pass.",
  pullRequestUrl: "https://github.com/acme/billing/pull/7",
};

function messageWith(records: ReadonlyArray<unknown>) {
  return { context: decodeContext({ version: 1, records }) };
}

function agentRecord(overrides: Record<string, unknown> = {}, label = "Fix billing webhooks") {
  return {
    version: 1,
    kind: "trevize-agent",
    contextId: "tvz-1",
    label,
    payload: { ...payload, ...overrides },
  };
}

describe("trevizeAgentUpdateOf", () => {
  it("decodes an agent update that upstream contracts preserved as an unknown kind", () => {
    expect(trevizeAgentUpdateOf(messageWith([agentRecord()]))).toEqual({
      contextId: "tvz-1",
      direction: "to-orchestrator",
      thread: payload.thread,
      title: "Fix billing webhooks",
      event: "pull_request",
      summary: "opened a pull request",
      detail: "Adds retries.\n\nTests pass.",
      pullRequestUrl: "https://github.com/acme/billing/pull/7",
    });
  });

  it("is null for messages without a trevize-agent record", () => {
    expect(trevizeAgentUpdateOf({})).toBeNull();
    expect(
      trevizeAgentUpdateOf(
        messageWith([
          { version: 1, kind: "other-kind", contextId: "x1", label: "x", payload: payload },
        ]),
      ),
    ).toBeNull();
  });

  it("skips malformed payloads and picks the first valid update", () => {
    const message = messageWith([
      { ...agentRecord({ event: "exploded" }), contextId: "tvz-bad" },
      { ...agentRecord({ direction: "to-agent" }), contextId: "tvz-good" },
    ]);
    expect(trevizeAgentUpdateOf(message)?.contextId).toBe("tvz-good");
    expect(trevizeAgentUpdateOf(messageWith([agentRecord({ v: 2 })]))).toBeNull();
  });

  it("falls back to the label, drops blank detail, and rejects non-http PR links", () => {
    const update = trevizeAgentUpdateOf(
      messageWith([
        agentRecord({
          thread: { ...payload.thread, title: null },
          detail: "  ",
          pullRequestUrl: "javascript:alert(1)",
        }),
      ]),
    );
    expect(update).toMatchObject({
      title: "Fix billing webhooks",
      detail: null,
      pullRequestUrl: null,
    });
  });

  it("names the other party generically when neither title nor label is set", () => {
    const update = trevizeAgentUpdateOf(
      messageWith([
        agentRecord({ direction: "to-agent", thread: { ...payload.thread, title: " " } }, ""),
      ]),
    );
    expect(update?.title).toBe("Orchestrator");
  });
});

describe("decodeTrevizeAgentRecord", () => {
  it("ignores known context kinds", () => {
    const [record] = messageWith([
      { version: 1, kind: "skill", contextId: "s1", label: "Skill", name: "review" },
    ]).context.records;
    expect(record === undefined ? undefined : decodeTrevizeAgentRecord(record)).toBeNull();
  });
});

describe("trevizeAgentUpdateTarget", () => {
  const environments = [
    { id: "env_agent", spaceId: "spc_1" },
    { id: "env_orch", spaceId: "spc_1" },
    { id: "env_other" },
  ];
  const activeSpace = { id: "spc_1", orchestratorThreadId: "thr_orch" };

  it("activates the agent's tab inside its space", () => {
    expect(trevizeAgentUpdateTarget({ thread: payload.thread, activeSpace, environments })).toEqual(
      { _tag: "SpaceTab", spaceId: "spc_1", tab: "thr_agent" },
    );
  });

  it("activates the space chat for the orchestrator", () => {
    const thread = { ...payload.thread, id: "thr_orch", environmentId: "env_orch" };
    expect(trevizeAgentUpdateTarget({ thread, activeSpace, environments })).toEqual({
      _tag: "SpaceTab",
      spaceId: "spc_1",
      tab: null,
    });
  });

  it("opens the thread outside its space", () => {
    const expected = {
      _tag: "OpenThread",
      thread: { id: "thr_agent", environmentId: "env_agent", t3ThreadId: "t3-agent" },
    };
    expect(
      trevizeAgentUpdateTarget({ thread: payload.thread, activeSpace: null, environments }),
    ).toEqual(expected);
    expect(
      trevizeAgentUpdateTarget({
        thread: payload.thread,
        activeSpace: { id: "spc_2", orchestratorThreadId: null },
        environments,
      }),
    ).toEqual(expected);
  });
});

describe("trevizeAgentMessageBody", () => {
  it("strips the lead-in line that references the orchestrator", () => {
    expect(
      trevizeAgentMessageBody(
        "Message from your orchestrator [Billing [v2]](t3-context://v1/trevize-agent/ctx_1):\n\nRebase onto main.\n\nThen rerun tests.",
      ),
    ).toBe("Rebase onto main.\n\nThen rerun tests.");
  });

  it("matches any lead-in wording and CRLF line endings", () => {
    expect(
      trevizeAgentMessageBody(
        "From [Orchestrator](t3-context://v1/trevize-agent/ctx_1) :\r\n\r\nShip it.",
      ),
    ).toBe("Ship it.");
  });

  it("keeps text without a trevize-agent lead-in", () => {
    const cases = [
      "Rebase onto main.",
      // Another kind of reference.
      "See [file](t3-context://v1/file/ctx_2):\n\nRebase onto main.",
      // No blank line after the lead-in.
      "Message from [Orchestrator](t3-context://v1/trevize-agent/ctx_1):\nRebase onto main.",
      // The reference is not on the first line.
      "Hi\nMessage from [Orchestrator](t3-context://v1/trevize-agent/ctx_1):\n\nRebase.",
    ];
    for (const text of cases) expect(trevizeAgentMessageBody(text)).toBe(text);
  });
});
