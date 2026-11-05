import { describe, expect, it } from "vitest";

import {
  beginCloudLaunch,
  endCloudLaunch,
  queueCloudLaunchMessage,
  takeCloudLaunchQueue,
} from "./cloudLaunches";

describe("cloud launch queue", () => {
  it("queues sends while starting and closes once a take finds nothing left", () => {
    const key = "draft-1";
    expect(queueCloudLaunchMessage(key, "too early")).toBe("none");

    beginCloudLaunch(key, { repository: "acme/web", branch: null, prompt: "Fix it" });
    expect(queueCloudLaunchMessage(key, "Also the docs")).toBe("queued");
    expect(takeCloudLaunchQueue(key)).toEqual(["Also the docs"]);

    // Sent while the first batch went out: the next take still picks it up.
    expect(queueCloudLaunchMessage(key, "And a PR")).toBe("queued");
    expect(takeCloudLaunchQueue(key)).toEqual(["And a PR"]);

    // Nothing left: the thread opens next, so later sends stay in the composer.
    expect(takeCloudLaunchQueue(key)).toEqual([]);
    expect(queueCloudLaunchMessage(key, "late")).toBe("opening");

    expect(endCloudLaunch(key)?.messages.map((message) => message.text)).toEqual([
      "Fix it",
      "Also the docs",
      "And a PR",
    ]);
    expect(queueCloudLaunchMessage(key, "after")).toBe("none");
  });
});
