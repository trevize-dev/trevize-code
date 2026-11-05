import type { TrevizeSync } from "@t3tools/client-runtime/trevize";
import type { WorktreeSetupStage } from "@t3tools/contracts";

import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import type { CloudLaunch } from "~/trevize/cloudLaunches";
import { WorkLogRow } from "./WorkLog";
import { Elapsed, ShimmerOverlay, StageIcon, stageRowClassName } from "./WorktreeSetupCard";

const PHASES: ReadonlyArray<TrevizeSync.CloudLaunchPhase> = [
  "creating",
  "starting",
  "starting-agent",
];

function phaseLabel(phase: TrevizeSync.CloudLaunchPhase, launch: CloudLaunch): string {
  switch (phase) {
    case "creating":
      return "Creating sandbox";
    case "starting":
      // Trevize reports booting and cloning as one step.
      return launch.branch
        ? `Setting up sandbox, checking out ${launch.repository} (${launch.branch})`
        : `Setting up sandbox, checking out ${launch.repository}`;
    case "starting-agent":
      return "Starting agent";
  }
}

function PhaseRow({ phase, launch }: { phase: TrevizeSync.CloudLaunchPhase; launch: CloudLaunch }) {
  const index = PHASES.indexOf(phase);
  const current = PHASES.indexOf(launch.phase);
  const status: WorktreeSetupStage["status"] =
    index < current ? "done" : index === current ? "running" : "pending";
  const running = status === "running";
  const label = phaseLabel(phase, launch);
  const next = PHASES[index + 1];
  return (
    <WorkLogRow
      icon={
        <span className={cn("text-icon-muted", status === "pending" && "opacity-40")}>
          <StageIcon status={status} />
        </span>
      }
      label={
        <span
          ref={running ? observeVisibleAnimation : undefined}
          className={cn("relative block truncate", stageRowClassName(status))}
        >
          {label}
          {running ? <ShimmerOverlay>{label}</ShimmerOverlay> : null}
        </span>
      }
      trailing={
        status === "pending" ? null : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums empty:hidden">
            <Elapsed
              startedAt={launch.phaseStartedAt[phase] ?? null}
              endedAt={next === undefined ? null : (launch.phaseStartedAt[next] ?? null)}
              live={running}
            />
          </span>
        )
      }
    />
  );
}

/** A cloud session starting from this draft: its steps, and what waits for the agent. */
export function CloudLaunchCard({ launch }: { launch: CloudLaunch }) {
  const queued = launch.messages.length - 1;
  return (
    <section aria-label="Starting cloud session" className="chat-content-lane">
      {PHASES.map((phase) => (
        <PhaseRow key={phase} phase={phase} launch={launch} />
      ))}
      <p className="mt-1 ml-8 text-xs text-muted-foreground">
        {queued > 0
          ? `${queued === 1 ? "1 message" : `${queued} messages`} queued until the agent starts.`
          : "A cold start can take a few minutes. Messages you send now are queued."}
      </p>
    </section>
  );
}
