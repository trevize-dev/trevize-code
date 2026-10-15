import { describe, expect, it } from "@effect/vitest";
import type { RepositoryIdentity } from "@t3tools/contracts";

import type { TrevizeSpace, TrevizeThread } from "./api.ts";
import {
  closeSpaceTab,
  defaultSpaceWorkspaceId,
  githubRepositorySlug,
  normalizeSpaceColor,
  openSpaceTab,
  parseSpaceIcon,
  spaceActivityAt,
  spaceAgents,
  spaceColorIndex,
  spaceEnvironmentFailed,
  spaceInitials,
  spaceNeedsYou,
  spaceSettingsDraft,
  spaceSettingsPatch,
} from "./spaces.ts";

function thread(id: string, overrides: Partial<TrevizeThread> = {}): TrevizeThread {
  return {
    id,
    environmentId: "env_space",
    t3ThreadId: `t3-${id}`,
    sourceKind: "orchestrator",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const space: TrevizeSpace = {
  id: "spc_1",
  workspaceId: "ws_1",
  name: "Billing revamp",
  repositoryIds: ["acme/billing"],
  orchestratorThreadId: "thr_orch",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const environments = [
  { id: "env_space", spaceId: "spc_1" },
  { id: "env_space_2", spaceId: "spc_1" },
  { id: "env_other", spaceId: null },
];

describe("spaceAgents", () => {
  it("lists the space's live threads except the orchestrator, latest activity first", () => {
    const threads = [
      thread("thr_orch", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      thread("thr_old", { updatedAt: "2026-10-02T00:00:00.000Z" }),
      thread("thr_new", { environmentId: "env_space_2", updatedAt: "2026-10-04T00:00:00.000Z" }),
      thread("thr_archived", { archived: true }),
      thread("thr_elsewhere", { environmentId: "env_other" }),
    ];
    expect(spaceAgents(space, threads, environments).map(({ id }) => id)).toEqual([
      "thr_new",
      "thr_old",
    ]);
  });
});

describe("spaceNeedsYou", () => {
  it("flags a space when one of its live threads waits on the user", () => {
    expect(spaceNeedsYou("spc_1", [thread("a", { status: "running" })], environments)).toBe(false);
    expect(spaceNeedsYou("spc_1", [thread("a", { waiting: true })], environments)).toBe(true);
    expect(
      spaceNeedsYou("spc_1", [thread("a", { waiting: true, archived: true })], environments),
    ).toBe(false);
    expect(
      spaceNeedsYou(
        "spc_1",
        [thread("a", { waiting: true, environmentId: "env_other" })],
        environments,
      ),
    ).toBe(false);
  });
});

describe("spaceActivityAt", () => {
  it("is the latest of the space's own update and its threads' activity", () => {
    expect(spaceActivityAt(space, [], environments)).toBe(space.updatedAt);
    expect(
      spaceActivityAt(
        space,
        [thread("a", { updatedAt: "2026-10-03T00:00:00.000Z" })],
        environments,
      ),
    ).toBe("2026-10-03T00:00:00.000Z");
  });
});

describe("spaceInitials and spaceColorIndex", () => {
  it("derives badge letters and a stable color", () => {
    expect(spaceInitials("Billing revamp")).toBe("BR");
    expect(spaceInitials("  operations ")).toBe("OP");
    expect(spaceInitials("")).toBe("?");
    expect(spaceColorIndex("spc_1", 6)).toBe(spaceColorIndex("spc_1", 6));
    expect(spaceColorIndex("spc_1", 6)).toBeGreaterThanOrEqual(0);
    expect(spaceColorIndex("spc_1", 6)).toBeLessThan(6);
  });
});

describe("githubRepositorySlug", () => {
  const identity = (canonicalKey: string, origin?: string): RepositoryIdentity => ({
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
    ...(origin ? { origin: { canonicalKey: origin } } : {}),
  });

  it("returns owner/repo for GitHub remotes, preferring a fork's own remote", () => {
    expect(githubRepositorySlug(identity("github.com/acme/web"))).toBe("acme/web");
    expect(githubRepositorySlug(identity("github.com/upstream/web", "github.com/acme/web"))).toBe(
      "acme/web",
    );
  });

  it("ignores projects without a GitHub remote", () => {
    expect(githubRepositorySlug(null)).toBeNull();
    expect(githubRepositorySlug(identity("gitlab.com/acme/web"))).toBeNull();
    expect(githubRepositorySlug(identity("github.com/acme"))).toBeNull();
  });
});

describe("defaultSpaceWorkspaceId", () => {
  it("prefers the settings workspace when it has spaces", () => {
    expect(defaultSpaceWorkspaceId("ws_2", ["ws_1", "ws_2"])).toBe("ws_2");
    expect(defaultSpaceWorkspaceId("ws_3", ["ws_1", "ws_2"])).toBe("ws_1");
    expect(defaultSpaceWorkspaceId(null, [])).toBeNull();
  });
});

describe("space tabs", () => {
  it("opens a tab once, at the end", () => {
    expect(openSpaceTab(["a"], "b")).toEqual(["a", "b"]);
    const tabs = ["a", "b"];
    expect(openSpaceTab(tabs, "a")).toBe(tabs);
  });

  it("moves the active tab to a neighbour, then to the space chat", () => {
    expect(closeSpaceTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], active: "c" });
    expect(closeSpaceTab(["a", "b"], "b", "b")).toEqual({ tabs: ["a"], active: "a" });
    expect(closeSpaceTab(["a"], "a", "a")).toEqual({ tabs: [], active: null });
    expect(closeSpaceTab(["a", "b"], "a", null)).toEqual({ tabs: ["b"], active: null });
  });
});

describe("spaceEnvironmentFailed", () => {
  it("flags a failed environment of the space only", () => {
    const environments = [
      { spaceId: "spc_1", status: "running" },
      { spaceId: "spc_2", status: "failed" },
      { spaceId: null, status: "failed" },
    ] as const;
    expect(spaceEnvironmentFailed("spc_1", environments)).toBe(false);
    expect(spaceEnvironmentFailed("spc_2", environments)).toBe(true);
  });
});

describe("parseSpaceIcon", () => {
  it("reads kebab-case names as Lucide icons and anything else as an emoji", () => {
    expect(parseSpaceIcon("rocket")).toEqual({ kind: "icon", name: "rocket" });
    expect(parseSpaceIcon("git-branch")).toEqual({ kind: "icon", name: "git-branch" });
    expect(parseSpaceIcon("👩‍💻")).toEqual({ kind: "emoji", emoji: "👩‍💻" });
    expect(parseSpaceIcon(null)).toBeNull();
    expect(parseSpaceIcon("  ")).toBeNull();
  });
});

describe("normalizeSpaceColor", () => {
  it("keeps six-digit hex colors, lowercased", () => {
    expect(normalizeSpaceColor("#6E56CF")).toBe("#6e56cf");
    expect(normalizeSpaceColor("red")).toBeNull();
    expect(normalizeSpaceColor(undefined)).toBeNull();
  });
});

describe("spaceSettingsPatch", () => {
  const settings = {
    name: "Billing",
    icon: null,
    color: null,
    instructions: "Ship small PRs.",
    maxEnvironments: 4,
  };

  it("is null when nothing changed", () => {
    expect(spaceSettingsPatch(settings, spaceSettingsDraft(settings))).toBeNull();
    expect(
      spaceSettingsPatch(settings, { ...spaceSettingsDraft(settings), name: "  Billing " }),
    ).toBeNull();
  });

  it("sends only the changed fields", () => {
    expect(
      spaceSettingsPatch(settings, {
        ...spaceSettingsDraft(settings),
        name: " Payments ",
        icon: "rocket",
        color: "#6e56cf",
      }),
    ).toEqual({ name: "Payments", icon: "rocket", color: "#6e56cf" });
    expect(
      spaceSettingsPatch(settings, { ...spaceSettingsDraft(settings), maxEnvironments: 8 }),
    ).toEqual({ maxEnvironments: 8 });
  });

  it("clears blank instructions and resets the icon with null", () => {
    const styled = { ...settings, icon: "🚀", color: "#6e56cf" };
    expect(
      spaceSettingsPatch(styled, {
        ...spaceSettingsDraft(styled),
        icon: null,
        color: null,
        instructions: "  ",
      }),
    ).toEqual({ icon: null, color: null, instructions: null });
  });

  it("never sends a blank name", () => {
    expect(spaceSettingsPatch(settings, { ...spaceSettingsDraft(settings), name: " " })).toBeNull();
  });
});
