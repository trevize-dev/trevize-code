import { describe, expect, it } from "vite-plus/test";

import { resolveTrevizeEnvironmentNotice, trevizeStartStepOf } from "./startProgress.logic";

describe("resolveTrevizeEnvironmentNotice", () => {
  const progress = (
    status: "provisioning" | "starting" | "stopped" | "failed",
    phase: string | null = null,
    recovering = false,
    error: string | null = null,
  ) => ({ status, phase, recovering, error });

  it.each([
    ["sandbox", "sandbox", 1],
    ["replacing-sandbox", "sandbox", 1],
    ["runtime-env", "network", 2],
    ["space", "repositories", 3],
    ["runtime", "runtime", 4],
    ["a-phase-from-a-newer-server", "sandbox", 1],
  ] as const)("shows phase %s as step %s (%i)", (phase, step, stepNumber) => {
    expect(trevizeStartStepOf(phase)).toBe(step);
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: progress("starting", phase),
        waking: false,
        sleeping: false,
      }),
    ).toMatchObject({ kind: "starting", step, stepNumber });
  });

  it("carries a recovery through every step and flags the sandbox replacement", () => {
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: progress("starting", "replacing-sandbox", true),
        waking: false,
        sleeping: false,
      }),
    ).toMatchObject({
      kind: "starting",
      recovering: true,
      replacingSandbox: true,
    });
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: progress("starting", "repositories", true),
        waking: true,
        sleeping: false,
      }),
    ).toMatchObject({
      step: "repositories",
      recovering: true,
      replacingSandbox: false,
    });
  });

  it("treats this device's wake as starting before Trevize reports it, even after a failure", () => {
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: progress("failed", null, false, "boom"),
        waking: true,
        sleeping: false,
      }),
    ).toMatchObject({ kind: "starting", step: "sandbox" });
  });

  it("reports a failed start with its error, and a stopped environment as asleep", () => {
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: progress("failed", null, false, "boom"),
        waking: false,
        sleeping: false,
      }),
    ).toEqual({ kind: "failed", error: "boom" });
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: undefined,
        waking: false,
        sleeping: true,
      }),
    ).toEqual({ kind: "asleep" });
  });

  it("leaves running and non-Trevize environments to the connection banner", () => {
    expect(
      resolveTrevizeEnvironmentNotice({
        progress: undefined,
        waking: false,
        sleeping: false,
      }),
    ).toBeNull();
  });
});
