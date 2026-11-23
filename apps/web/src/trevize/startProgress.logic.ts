import { TrevizeSync } from "@t3tools/client-runtime/trevize";

/**
 * The steps a Trevize environment start shows, in order. Trevize reports
 * finer phases (`TrevizeEnvironmentStart.phase`); several map to one step.
 */
export const TREVIZE_START_STEPS = ["sandbox", "network", "repositories", "runtime"] as const;
export type TrevizeStartStep = (typeof TREVIZE_START_STEPS)[number];

/** The step a Trevize start phase belongs to; unknown phases count as the first. */
export function trevizeStartStepOf(phase: string | null): TrevizeStartStep {
  switch (phase) {
    case "network":
    case "runtime-env":
      return "network";
    case "repositories":
    case "space":
      return "repositories";
    case "runtime":
      return "runtime";
    default:
      return "sandbox";
  }
}

/** What the composer says about a Trevize environment that is not connected. */
export type TrevizeEnvironmentNotice =
  | { readonly kind: "asleep" }
  | {
      readonly kind: "starting";
      readonly step: TrevizeStartStep;
      /** 1-based position of `step` in {@link TREVIZE_START_STEPS}. */
      readonly stepNumber: number;
      /** Trevize replaced a sandbox that broke on the provider. */
      readonly recovering: boolean;
      /** The new sandbox is being created (`replacing-sandbox`). */
      readonly replacingSandbox: boolean;
    }
  | { readonly kind: "failed"; readonly error: string | null };

function starting(phase: string | null, recovering: boolean): TrevizeEnvironmentNotice {
  const step = trevizeStartStepOf(phase);
  return {
    kind: "starting",
    step,
    stepNumber: TREVIZE_START_STEPS.indexOf(step) + 1,
    recovering,
    replacingSandbox: phase === "replacing-sandbox",
  };
}

/**
 * The notice for a saved Trevize environment, or null when Trevize has
 * nothing to add (it runs, or this is not a Trevize environment): then the
 * plain connection banner applies. A wake from this device counts as
 * starting even before Trevize reports the start.
 */
export function resolveTrevizeEnvironmentNotice(input: {
  readonly progress: TrevizeSync.TrevizeStartProgress | undefined;
  readonly waking: boolean;
  readonly sleeping: boolean;
}): TrevizeEnvironmentNotice | null {
  const { progress } = input;
  if (progress !== undefined && TrevizeSync.isTrevizeStartInFlight(progress)) {
    return starting(progress.phase, progress.recovering);
  }
  if (input.waking) return starting(null, false);
  if (progress?.status === "failed") return { kind: "failed", error: progress.error };
  if (progress?.status === "stopped" || input.sleeping) return { kind: "asleep" };
  return null;
}
