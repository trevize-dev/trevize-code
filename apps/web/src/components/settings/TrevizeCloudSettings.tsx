import { useAtomValue } from "@effect/atom-react";
import {
  findSavedTrevizeEnvironment,
  TrevizeApi,
  type TrevizeDeviceSignIn,
} from "@t3tools/client-runtime/trevize";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Trevize from "~/trevize/commands";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const TRANSITIONAL_STATUSES: ReadonlySet<TrevizeApi.TrevizeEnvironmentStatus> = new Set([
  "provisioning",
  "starting",
]);
const STOPPABLE_STATUSES: ReadonlySet<TrevizeApi.TrevizeEnvironmentStatus> = new Set([
  "provisioning",
  "starting",
  "running",
]);
const STATUS_REFRESH_INTERVAL_MS = 5_000;

const STATUS_LABELS: Record<TrevizeApi.TrevizeEnvironmentStatus, string> = {
  provisioning: "Provisioning",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  archived: "Archived",
};

function failureMessage(failure: { readonly cause: Cause.Cause<unknown> }, fallback: string) {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error && error.message ? error.message : fallback;
}

function reportFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title,
    description: failureMessage(result, "Trevize did not complete the request."),
  });
}

const DEFAULT_SETTINGS = Trevize.defaultTrevizeSettings();

function environmentTitle(environment: TrevizeApi.TrevizeEnvironment): string {
  return environment.title?.trim() || environment.id;
}

/**
 * Trevize Cloud environments: T3 servers Trevize runs in cloud sandboxes.
 * Connecting asks Trevize for a one-time pairing token and pairs like any
 * other environment, so a connected one is also listed under Environments.
 */
export function TrevizeCloudSettings() {
  const [settings, setSettings] = useLocalStorage(
    Trevize.TREVIZE_SETTINGS_STORAGE_KEY,
    DEFAULT_SETTINGS,
    Trevize.TrevizeClientSettings,
  );
  // Undefined while the stored key is read.
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const loadApiKey = useAtomCommand(Trevize.loadApiKey, { reportFailure: false });
  const signOut = useAtomCommand(Trevize.signOut, { reportFailure: false });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the saved Trevize key from the credential store on mount
  useEffect(() => {
    let active = true;
    void loadApiKey().then((result) => {
      if (active) setApiKey(result._tag === "Success" ? Option.getOrNull(result.value) : null);
    });
    return () => {
      active = false;
    };
  }, [loadApiKey]);

  const config = apiKey ? { baseUrl: settings.baseUrl, apiKey } : null;

  return (
    <SettingsSection
      {...searchableSetting("trevize-cloud")}
      headerAction={
        config ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              void signOut(config).then((result) => {
                if (result._tag === "Success") setApiKey(null);
                else reportFailure(result, "Could not sign out of Trevize");
              });
            }}
          >
            Sign out
          </Button>
        ) : null
      }
    >
      {apiKey === undefined ? null : config ? (
        <>
          <TrevizeAutoConnectRow
            autoConnect={settings.autoConnect}
            onAutoConnectChange={(autoConnect) =>
              setSettings((current) => ({ ...current, autoConnect }))
            }
          />
          <TrevizeWorkspaceEnvironments
            config={config}
            workspaceId={settings.workspaceId}
            onWorkspaceChange={(workspaceId) =>
              setSettings((current) => ({ ...current, workspaceId }))
            }
          />
        </>
      ) : (
        <TrevizeSignInForm
          baseUrl={settings.baseUrl}
          onSignedIn={(signedIn, workspaces) => {
            const workspaceId = workspaces.some((item) => item.id === settings.workspaceId)
              ? settings.workspaceId
              : (workspaces[0]?.id ?? null);
            setSettings((current) => ({ ...current, baseUrl: signedIn.baseUrl, workspaceId }));
            setApiKey(signedIn.apiKey);
          }}
        />
      )}
    </SettingsSection>
  );
}

/** Background sync: pairs running environments and keeps the saved list current. */
function TrevizeAutoConnectRow({
  autoConnect,
  onAutoConnectChange,
}: {
  readonly autoConnect: boolean;
  readonly onAutoConnectChange: (autoConnect: boolean) => void;
}) {
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  const syncNow = useAtomCommand(Trevize.syncNow, { reportFailure: false });
  return (
    <SettingsRow
      title="Automatically connect Trevize environments"
      description={
        sync.error
          ? `Last sync failed: ${sync.error}`
          : "Running environments of every workspace appear under Environments without clicking Connect. Archived ones are removed."
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={sync.syncing}
            onClick={() => void syncNow()}
          >
            {sync.syncing ? <Spinner size="sm" /> : null}
            Sync now
          </Button>
          <Switch
            size="sm"
            checked={autoConnect}
            aria-label="Automatically connect Trevize environments"
            onCheckedChange={(checked) => {
              onAutoConnectChange(checked);
              if (checked) void syncNow();
            }}
          />
        </div>
      }
    />
  );
}

type DeviceSignInState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly signIn: TrevizeDeviceSignIn };

/**
 * Signs in by approving a code on Trevize in the browser (the device grant the
 * Trevize CLI uses), with a pasted API key as the fallback for a Trevize that
 * does not support it yet.
 */
function TrevizeSignInForm({
  baseUrl,
  onSignedIn,
}: {
  readonly baseUrl: string;
  readonly onSignedIn: (
    config: TrevizeApi.TrevizeApiConfig,
    workspaces: ReadonlyArray<TrevizeApi.TrevizeWorkspace>,
  ) => void;
}) {
  const signIn = useAtomCommand(Trevize.signIn, { reportFailure: false });
  const startDeviceSignIn = useAtomCommand(Trevize.startDeviceSignIn, { reportFailure: false });
  const completeDeviceSignIn = useAtomCommand(Trevize.completeDeviceSignIn, {
    reportFailure: false,
  });
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [keyDraft, setKeyDraft] = useState("");
  const [useApiKey, setUseApiKey] = useState(false);
  const [device, setDevice] = useState<DeviceSignInState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pendingSignIn = useRef<AbortController | null>(null);

  // Stop polling when the form goes away.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the pending device sign-in on unmount
  useEffect(() => () => pendingSignIn.current?.abort(), []);

  const normalizedUrl = (): string | null => {
    try {
      return TrevizeApi.normalizeTrevizeBaseUrl(urlDraft.trim() || Trevize.defaultTrevizeBaseUrl());
    } catch {
      setError("Enter a valid Trevize URL.");
      return null;
    }
  };

  const openApproval = (signIn: TrevizeDeviceSignIn) => {
    void readLocalApi()?.shell.openExternal(signIn.verificationUrl);
  };

  const signInWithBrowser = async () => {
    const url = normalizedUrl();
    if (url === null) return;
    setError(null);
    setDevice({ kind: "starting" });
    const started = await startDeviceSignIn(url);
    if (started._tag !== "Success") {
      setDevice({ kind: "idle" });
      if (!isAtomCommandInterrupted(started)) {
        setError(failureMessage(started, "Could not start signing in to Trevize."));
      }
      return;
    }
    const controller = new AbortController();
    pendingSignIn.current = controller;
    setDevice({ kind: "waiting", signIn: started.value });
    openApproval(started.value);
    const result = await completeDeviceSignIn({
      signIn: started.value,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    pendingSignIn.current = null;
    setDevice({ kind: "idle" });
    if (result._tag === "Success") {
      onSignedIn(result.value.config, result.value.workspaces);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not sign in to Trevize."));
    }
  };

  const cancelDeviceSignIn = () => {
    pendingSignIn.current?.abort();
    pendingSignIn.current = null;
    setDevice({ kind: "idle" });
  };

  const signInWithApiKey = async () => {
    const url = normalizedUrl();
    if (url === null) return;
    const config = { baseUrl: url, apiKey: keyDraft.trim() };
    setSubmitting(true);
    setError(null);
    const result = await signIn(config);
    setSubmitting(false);
    if (result._tag === "Success") {
      setKeyDraft("");
      onSignedIn(config, result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not sign in to Trevize."));
    }
  };

  if (device.kind === "waiting") {
    return (
      <div className={ITEM_ROW_CLASSNAME}>
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Approve this code in Trevize to finish signing in.
          </p>
          <div className="flex items-center gap-3">
            <span className="font-mono text-lg tracking-widest">{device.signIn.userCode}</span>
            <Spinner size="sm" />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="xs" variant="ghost-muted" onClick={cancelDeviceSignIn}>
              Cancel
            </Button>
            <Button size="xs" variant="outline" onClick={() => openApproval(device.signIn)}>
              Open Trevize
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!useApiKey) void signInWithBrowser();
          else if (keyDraft.trim()) void signInWithApiKey();
        }}
      >
        <p className="text-xs text-muted-foreground">
          Run environments in Trevize cloud sandboxes and connect to them from here.
        </p>
        <fieldset disabled={submitting || device.kind === "starting"} className="contents">
          <div className={useApiKey ? "grid gap-3 sm:grid-cols-[16rem_1fr]" : "grid gap-3"}>
            <div className="grid gap-1.5">
              <Label htmlFor="trevize-base-url">Trevize URL</Label>
              <Input
                id="trevize-base-url"
                size="sm"
                autoComplete="off"
                placeholder={Trevize.defaultTrevizeBaseUrl()}
                value={urlDraft}
                onChange={(event) => setUrlDraft(event.target.value)}
              />
            </div>
            {useApiKey ? (
              <div className="grid gap-1.5">
                <Label htmlFor="trevize-api-key">API key</Label>
                <Input
                  id="trevize-api-key"
                  size="sm"
                  type="password"
                  autoComplete="off"
                  placeholder="tvz_…"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-destructive">{error}</p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                onClick={() => {
                  setUseApiKey((current) => !current);
                  setError(null);
                }}
              >
                {useApiKey ? "Sign in with browser" : "Use an API key"}
              </Button>
              <Button type="submit" size="xs" disabled={useApiKey && !keyDraft.trim()}>
                {submitting || device.kind === "starting" ? <Spinner size="sm" /> : null}
                {useApiKey ? "Sign in" : "Sign in with Trevize"}
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

function TrevizeWorkspaceEnvironments({
  config,
  workspaceId,
  onWorkspaceChange,
}: {
  readonly config: TrevizeApi.TrevizeApiConfig;
  readonly workspaceId: string | null;
  readonly onWorkspaceChange: (workspaceId: string) => void;
}) {
  const listWorkspaces = useAtomCommand(Trevize.listWorkspaces, { reportFailure: false });
  const listEnvironments = useAtomCommand(Trevize.listEnvironments, { reportFailure: false });
  const connectEnvironment = useAtomCommand(Trevize.connectEnvironment, { reportFailure: false });
  const stopEnvironment = useAtomCommand(Trevize.stopEnvironment, { reportFailure: false });
  const wakeEnvironment = useAtomCommand(Trevize.wakeEnvironment, { reportFailure: false });
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  const { environments: savedEnvironments } = useEnvironments();
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<TrevizeApi.TrevizeWorkspace>>([]);
  // Keyed by workspace so switching workspaces never shows the previous list.
  const [loaded, setLoaded] = useState<{
    readonly workspaceId: string;
    readonly environments: ReadonlyArray<TrevizeApi.TrevizeEnvironment>;
  } | null>(null);
  const environments = loaded?.workspaceId === workspaceId ? loaded.environments : null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  // A missing or stale selection falls back to the first workspace once per load.
  const selectFallbackWorkspace = useEffectEvent(
    (loaded: ReadonlyArray<TrevizeApi.TrevizeWorkspace>) => {
      const first = loaded[0];
      if (first && !loaded.some((workspace) => workspace.id === workspaceId)) {
        onWorkspaceChange(first.id);
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the account's workspaces from Trevize
  useEffect(() => {
    let active = true;
    void listWorkspaces(config).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setWorkspaces(result.value);
        selectFallbackWorkspace(result.value);
      } else if (!isAtomCommandInterrupted(result)) {
        setLoadError(failureMessage(result, "Could not load Trevize workspaces."));
      }
    });
    return () => {
      active = false;
    };
  }, [config, listWorkspaces]);

  const refresh = async () => {
    if (!workspaceId) return;
    await listEnvironments({ config, workspaceId }).then((result) => {
      if (result._tag === "Success") {
        setLoaded({
          workspaceId,
          environments: result.value.filter((environment) => environment.status !== "archived"),
        });
        setLoadError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        setLoadError(failureMessage(result, "Could not load Trevize environments."));
      }
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected workspace's environments from Trevize
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while an environment is on its way up, so the status settles on its own.
  const hasTransitional =
    environments?.some((environment) => TRANSITIONAL_STATUSES.has(environment.status)) ?? false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls Trevize while an environment is starting or stopping
  useEffect(() => {
    if (!hasTransitional) return;
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasTransitional, refresh]);

  const withBusy = async (id: string, run: () => Promise<void>) => {
    setBusyIds((current) => new Set([...current, id]));
    try {
      await run();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const connect = (environment: TrevizeApi.TrevizeEnvironment) =>
    withBusy(environment.id, async () => {
      const result = await connectEnvironment({ config, environment });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Environment connected",
          description: `${environmentTitle(environment)} is saved and will reconnect on app startup.`,
        });
      } else {
        reportFailure(result, "Could not connect environment");
      }
      await refresh();
    });

  const stop = (environment: TrevizeApi.TrevizeEnvironment) =>
    withBusy(environment.id, async () => {
      reportFailure(
        await stopEnvironment({ config, environmentId: environment.id }),
        "Could not stop environment",
      );
      await refresh();
    });

  const wake = (environment: TrevizeApi.TrevizeEnvironment, savedId: EnvironmentId) =>
    withBusy(environment.id, async () => {
      reportFailure(await wakeEnvironment(savedId), "Could not wake environment");
      await refresh();
    });

  const savedEntries = savedEnvironments.map((environment) => environment.entry);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

  return (
    <>
      <SettingsRow
        title="Workspace"
        description={`Signed in to ${new URL(config.baseUrl).host}.`}
        control={
          <div className="flex items-center gap-2">
            <Select
              value={workspaceId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value) onWorkspaceChange(value);
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Trevize workspace">
                <SelectValue>{selectedWorkspace?.name ?? "Select a workspace"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {workspaces.map((workspace) => (
                  <SelectItem hideIndicator key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={!workspaceId}
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-3" />
              New environment
            </Button>
          </div>
        }
      />
      {loadError ? (
        <SettingsRow title="Could not reach Trevize" description={loadError} />
      ) : environments === null ? null : environments.length === 0 ? (
        <SettingsRow
          title="No environments"
          description="Create an environment to start a cloud sandbox with your repositories."
        />
      ) : (
        environments.map((environment) => {
          const savedId = findSavedTrevizeEnvironment(savedEntries, environment.httpBaseUrl);
          const saved = savedId !== null;
          // A saved, stopped environment sleeps: its connection waits for a wake.
          const sleeping = savedId !== null && environment.status === "stopped";
          const busy =
            busyIds.has(environment.id) || (savedId !== null && sync.waking.has(savedId));
          const statusText = [
            sleeping ? "Sleeping" : STATUS_LABELS[environment.status],
            saved ? "Saved on this device" : null,
            environment.error ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={environment.id} className={ITEM_ROW_CLASSNAME}>
              <div className={ITEM_ROW_INNER_CLASSNAME}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{environmentTitle(environment)}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{statusText}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {STOPPABLE_STATUSES.has(environment.status) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void stop(environment)}
                    >
                      Stop
                    </Button>
                  ) : null}
                  {sleeping ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void wake(environment, savedId)}
                    >
                      {busy ? <Spinner size="sm" /> : null}
                      Wake
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={saved ? "outline" : "default"}
                      disabled={busy || environment.status === "failed"}
                      onClick={() => void connect(environment)}
                    >
                      {busy ? <Spinner size="sm" /> : null}
                      {saved ? "Reconnect" : "Connect"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
      {workspaceId ? (
        <NewTrevizeEnvironmentDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          config={config}
          workspaceId={workspaceId}
          onCreated={() => void refresh()}
        />
      ) : null}
    </>
  );
}

function NewTrevizeEnvironmentDialog({
  open,
  onOpenChange,
  config,
  workspaceId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly config: TrevizeApi.TrevizeApiConfig;
  readonly workspaceId: string;
  readonly onCreated: () => void;
}) {
  const listRepositories = useAtomCommand(Trevize.listRepositories, { reportFailure: false });
  const createEnvironment = useAtomCommand(Trevize.createEnvironment, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly workspaceId: string;
    readonly repositories: ReadonlyArray<TrevizeApi.TrevizeRepository>;
  } | null>(null);
  const repositories = loaded?.workspaceId === workspaceId ? loaded.repositories : null;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the workspace's repositories from Trevize when the dialog opens
  useEffect(() => {
    if (!open) return;
    let active = true;
    void listRepositories({ config, workspaceId }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") setLoaded({ workspaceId, repositories: result.value });
      else if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, "Could not load repositories."));
      }
    });
    return () => {
      active = false;
    };
  }, [config, listRepositories, open, workspaceId]);

  const create = async () => {
    setCreating(true);
    setError(null);
    const result = await createEnvironment({
      config,
      workspaceId,
      repositoryIds: [...selected],
      title,
    });
    setCreating(false);
    if (result._tag === "Success") {
      handleOpenChange(false);
      onCreated();
      toastManager.add({
        type: "success",
        title: "Environment created",
        description: `${environmentTitle(result.value)} is starting. Connect when it is ready.`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not create the environment."));
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setTitle("");
      setError(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Trevize environment</DialogTitle>
          <DialogDescription>
            Trevize starts a cloud sandbox with the selected repositories, each added as a project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="trevize-environment-title">Title</Label>
              <Input
                id="trevize-environment-title"
                size="sm"
                autoComplete="off"
                placeholder="Optional"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Repositories</Label>
              {repositories === null ? (
                error ? null : (
                  <Spinner size="sm" />
                )
              ) : repositories.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No repositories. Connect GitHub to this workspace in Trevize first.
                </p>
              ) : (
                repositories.map((repository) => (
                  <label key={repository.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(repository.fullName)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(repository.fullName);
                          else next.delete(repository.fullName);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{repository.fullName}</span>
                  </label>
                ))
              )}
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={creating || selected.size === 0}
            onClick={() => void create()}
          >
            {creating ? <Spinner size="sm" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
