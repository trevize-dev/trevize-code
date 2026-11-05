import type { TrevizeSync } from "@t3tools/client-runtime/trevize";
import type { MessageId } from "@t3tools/contracts";
import { create } from "zustand";

import { newMessageId } from "~/lib/utils";

/** A message shown in a starting cloud session: its first prompt, then what was queued. */
export interface CloudLaunchMessage {
  readonly id: MessageId;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * A cloud session starting from a draft. The draft shows its messages and
 * progress until the thread exists, and queues what the user sends meanwhile.
 */
export interface CloudLaunch {
  readonly repository: string;
  readonly branch: string | null;
  readonly startedAt: string;
  readonly phase: TrevizeSync.CloudLaunchPhase;
  /** When each reached phase started. */
  readonly phaseStartedAt: Partial<Record<TrevizeSync.CloudLaunchPhase, string>>;
  readonly messages: ReadonlyArray<CloudLaunchMessage>;
  /** Queued prompts the launch has not taken yet. */
  readonly queued: ReadonlyArray<string>;
  /** False once the launch took its last queued batch: the thread is about to open. */
  readonly accepting: boolean;
}

interface CloudLaunchState {
  readonly launches: Readonly<Record<string, CloudLaunch>>;
}

const useCloudLaunchStore = create<CloudLaunchState>(() => ({ launches: {} }));

const updateLaunch = (key: string, update: (launch: CloudLaunch) => CloudLaunch) =>
  useCloudLaunchStore.setState((state) => {
    const launch = state.launches[key];
    return launch ? { launches: { ...state.launches, [key]: update(launch) } } : state;
  });

const message = (text: string, createdAt: string): CloudLaunchMessage => ({
  id: newMessageId(),
  text,
  createdAt,
});

/** The cloud session starting from the draft at `key`, if any. */
export function useCloudLaunch(key: string): CloudLaunch | null {
  return useCloudLaunchStore((state) => state.launches[key] ?? null);
}

export function beginCloudLaunch(
  key: string,
  input: { readonly repository: string; readonly branch: string | null; readonly prompt: string },
): void {
  const now = new Date().toISOString();
  useCloudLaunchStore.setState((state) => ({
    launches: {
      ...state.launches,
      [key]: {
        repository: input.repository,
        branch: input.branch,
        startedAt: now,
        phase: "creating",
        phaseStartedAt: { creating: now },
        messages: [message(input.prompt, now)],
        queued: [],
        accepting: true,
      },
    },
  }));
}

export function setCloudLaunchPhase(key: string, phase: TrevizeSync.CloudLaunchPhase): void {
  updateLaunch(key, (launch) => ({
    ...launch,
    phase,
    phaseStartedAt: { ...launch.phaseStartedAt, [phase]: new Date().toISOString() },
  }));
}

/**
 * Queues a prompt for the session starting from this draft: `queued`, `none`
 * without a launch, or `opening` once the thread is about to open (the prompt
 * then stays in the composer for the thread).
 */
export function queueCloudLaunchMessage(key: string, text: string): "queued" | "none" | "opening" {
  const launch = useCloudLaunchStore.getState().launches[key];
  if (!launch) return "none";
  if (!launch.accepting) return "opening";
  const now = new Date().toISOString();
  updateLaunch(key, (current) => ({
    ...current,
    messages: [...current.messages, message(text, now)],
    queued: [...current.queued, text],
  }));
  return "queued";
}

/** Takes the queued prompts; an empty take closes the queue, as the thread opens next. */
export function takeCloudLaunchQueue(key: string): ReadonlyArray<string> {
  const queued = useCloudLaunchStore.getState().launches[key]?.queued ?? [];
  updateLaunch(key, (launch) => ({ ...launch, queued: [], accepting: queued.length > 0 }));
  return queued;
}

/** Ends the launch and returns its last state. */
export function endCloudLaunch(key: string): CloudLaunch | null {
  const launch = useCloudLaunchStore.getState().launches[key] ?? null;
  useCloudLaunchStore.setState((state) => {
    const { [key]: _ended, ...launches } = state.launches;
    return { launches };
  });
  return launch;
}
