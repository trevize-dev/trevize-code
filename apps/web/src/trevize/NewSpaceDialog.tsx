import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TrevizeSpaces } from "@t3tools/client-runtime/trevize";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState, type ReactNode } from "react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "~/components/settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Trevize from "./commands";
import { useNewSpaceDialogStore } from "./Spaces";

interface CloudProject {
  /** `owner/repo`, what Trevize clones. */
  readonly slug: string;
  readonly title: string;
}

/** The user's projects that can run in the cloud: one row per GitHub repository. */
function useCloudProjects(): ReadonlyArray<CloudProject> {
  const projects = useProjects();
  const bySlug = new Map<string, CloudProject>();
  for (const project of projects) {
    const slug = TrevizeSpaces.githubRepositorySlug(project.repositoryIdentity);
    if (slug !== null && !bySlug.has(slug)) bySlug.set(slug, { slug, title: project.title });
  }
  return [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function Field(props: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  // A flex column, not `space-y`: Label and the model picker are both inline-level,
  // so in normal flow they share line boxes and the picker rides up into the label.
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

interface OrchestratorModelChoice {
  readonly instanceId: ProviderInstanceId;
  /** The instance's driver kind, which Trevize calls the provider. */
  readonly provider: string;
  readonly model: string;
}

/**
 * The orchestrator runs in the cloud, but its model is picked from the
 * providers this device's own server knows, with the composer's picker.
 */
function OrchestratorModelField(props: {
  readonly environmentId: EnvironmentId;
  readonly value: OrchestratorModelChoice | null;
  readonly disabled: boolean;
  readonly onChange: (value: OrchestratorModelChoice) => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const fallback = scheduledTaskDefaultModel(settings, null, instanceEntries);
  const { value, onChange } = props;
  const pick = (instanceId: ProviderInstanceId, model: string) => {
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (entry) onChange({ instanceId, provider: entry.driverKind, model });
  };
  // Start from the same default a new thread would use, so creating without
  // touching the picker still sends the model it shows.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seeds the dialog's model once the server's providers load, which can be after mount
  useEffect(() => {
    if (value === null && fallback !== null) pick(fallback.instanceId, fallback.model);
  }, [fallback, pick, value]);
  const activeInstanceId = value?.instanceId ?? instanceEntries[0]?.instanceId;
  const activeModel = value?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  if (activeInstanceId === undefined) return null;
  return (
    <Field label="Orchestrator" hint="Agents choose their own model per task.">
      <ProviderModelPicker
        environmentId={props.environmentId}
        disabled={props.disabled}
        activeInstanceId={activeInstanceId}
        model={activeModel}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        isComposerOwned={false}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onInstanceModelChange={pick}
      />
    </Field>
  );
}

/** Mounted once in the chat layout; opened through `openNewSpaceDialog`. */
export function NewSpaceDialogHost() {
  const open = useNewSpaceDialogStore((state) => state.open);
  const setOpen = useNewSpaceDialogStore((state) => state.setOpen);
  if (!open) return null;
  return <NewSpaceDialog onClose={() => setOpen(false)} />;
}

function NewSpaceDialog({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const create = useAtomCommand(Trevize.createSpace, { reportFailure: false });
  const projects = useCloudProjects();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [instructions, setInstructions] = useState("");
  const [maxEnvironments, setMaxEnvironments] = useState(TrevizeSpaces.DEFAULT_SPACE_ENVIRONMENTS);
  const [model, setModel] = useState<OrchestratorModelChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const instructionsId = useId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const canCreate = name.trim().length > 0 && picked.size > 0 && !saving;

  const submit = async () => {
    if (!canCreate) return;
    setSaving(true);
    const result = await create({
      name: name.trim(),
      instructions,
      repositoryIds: [...picked],
      maxEnvironments,
      orchestratorModel: model ? { provider: model.provider, model: model.model } : null,
    });
    setSaving(false);
    if (result._tag === "Success") {
      onClose();
      await navigate({ to: "/spaces/$spaceId", params: { spaceId: result.value.id } });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not create space",
      description: error instanceof Error ? error.message : "Trevize did not create it.",
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            A space has its own orchestrator chat, cloud environments and a shared{" "}
            <code>/shared</code> disk. The orchestrator hands work to agents, one branch each.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={saving} className="space-y-5">
              <Field label="Name" htmlFor={nameId}>
                <Input
                  id={nameId}
                  autoFocus
                  placeholder="e.g. Billing revamp"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field
                label="Projects"
                hint="Cloned into every environment of the space. Projects without a GitHub remote can't run in the cloud and aren't listed."
              >
                {projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None of your projects has a GitHub remote.
                  </p>
                ) : (
                  <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                    {projects.map((project) => (
                      <li key={project.slug}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                          <Checkbox
                            checked={picked.has(project.slug)}
                            onCheckedChange={(checked) =>
                              setPicked((current) => {
                                const next = new Set(current);
                                if (checked) next.add(project.slug);
                                else next.delete(project.slug);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">{project.title}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {project.slug}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>

              <Field
                label="Instructions"
                htmlFor={instructionsId}
                hint={
                  <>
                    Saved as <code>/shared/SPACE.md</code>, which every agent in the space reads.
                  </>
                }
              >
                <Textarea
                  id={instructionsId}
                  placeholder="Conventions, constraints and goals for this space."
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </Field>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Max parallel sandboxes"
                  hint="1–32. Idle sandboxes sleep after 30 minutes."
                >
                  <NumberField
                    min={1}
                    max={TrevizeSpaces.MAX_SPACE_ENVIRONMENTS}
                    value={maxEnvironments}
                    onValueChange={(value) =>
                      setMaxEnvironments(
                        Math.min(
                          TrevizeSpaces.MAX_SPACE_ENVIRONMENTS,
                          Math.max(1, Math.round(value ?? 1)),
                        ),
                      )
                    }
                    aria-label="Max parallel sandboxes"
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label="Fewer sandboxes" />
                      <NumberFieldInput />
                      <NumberFieldIncrement aria-label="More sandboxes" />
                    </NumberFieldGroup>
                  </NumberField>
                </Field>

                {primaryEnvironmentId !== null ? (
                  <OrchestratorModelField
                    environmentId={primaryEnvironmentId}
                    value={model}
                    disabled={saving}
                    onChange={setModel}
                  />
                ) : null}
              </div>
            </fieldset>
            {/* Lets Enter in the name field submit. */}
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canCreate} onClick={() => void submit()}>
            {saving ? <Spinner size="sm" /> : null}
            Create and open chat
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
