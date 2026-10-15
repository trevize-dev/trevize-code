import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TrevizeSpaces } from "@t3tools/client-runtime/trevize";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { create } from "zustand";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";
import * as Trevize from "./commands";
import { SpaceIconPicker } from "./SpaceIconPicker";
import { useSpaces, type Space } from "./Spaces";

/** Opens a space's settings from anywhere (space menu, command palette). */
export const useSpaceSettingsDialogStore = create<{
  readonly spaceId: string | null;
  readonly setSpaceId: (spaceId: string | null) => void;
}>((set) => ({ spaceId: null, setSpaceId: (spaceId) => set({ spaceId }) }));

export function openSpaceSettings(spaceId: string) {
  useSpaceSettingsDialogStore.getState().setSpaceId(spaceId);
}

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Trevize did not answer.",
  });
}

/** Asks, archives the space and leaves its page. Resolves to whether it was archived. */
export function useArchiveSpace(): (space: Pick<Space, "id" | "name">) => Promise<boolean> {
  const navigate = useNavigate();
  const archive = useAtomCommand(Trevize.archiveSpace, { reportFailure: false });
  return async (space) => {
    const message = `Archive "${space.name}"?\nIts orchestrator and agents stop showing here. Trevize keeps their history.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    const result = await archive(space.id);
    if (result._tag === "Success") {
      await navigate({ to: "/" });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not archive space", squashAtomCommandFailure(result));
    }
    return false;
  };
}

/** Mounted once in the chat layout; opened through `openSpaceSettings`. */
export function SpaceSettingsDialogHost() {
  const spaceId = useSpaceSettingsDialogStore((state) => state.spaceId);
  const setSpaceId = useSpaceSettingsDialogStore((state) => state.setSpaceId);
  const { spaces } = useSpaces();
  const space = spaceId === null ? null : spaces.find((candidate) => candidate.id === spaceId);
  if (!space) return null;
  return <SpaceSettingsDialog key={space.id} space={space} onClose={() => setSpaceId(null)} />;
}

function Row(props: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly description?: ReactNode;
  readonly control: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={props.htmlFor}>{props.label}</Label>
        {props.description ? (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      <div className="shrink-0 sm:w-64">{props.control}</div>
    </div>
  );
}

function SpaceSettingsDialog(props: { readonly space: Space; readonly onClose: () => void }) {
  const { space, onClose } = props;
  const update = useAtomCommand(Trevize.updateSpace, { reportFailure: false });
  const archiveSpace = useArchiveSpace();
  const [draft, setDraft] = useState(() => TrevizeSpaces.spaceSettingsDraft(space));
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  const instructionsId = useId();
  const patch = TrevizeSpaces.spaceSettingsPatch(space, draft);
  const canSave = patch !== null && draft.name.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await update({ spaceId: space.id, patch });
    setSaving(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    reportFailure("Could not save space settings", squashAtomCommandFailure(result));
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
          <DialogTitle>Space settings</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-6">
              <Row
                label="Name and icon"
                htmlFor={nameId}
                control={
                  <div className="flex items-center gap-2">
                    <SpaceIconPicker
                      space={{ id: space.id, name: draft.name.trim() || space.name }}
                      value={{ icon: draft.icon, color: draft.color }}
                      disabled={saving}
                      onChange={(value) => setDraft((current) => ({ ...current, ...value }))}
                    />
                    <Input
                      id={nameId}
                      autoFocus
                      aria-invalid={draft.name.trim().length === 0}
                      value={draft.name}
                      onChange={(event) => {
                        const name = event.currentTarget.value;
                        setDraft((current) => ({ ...current, name }));
                      }}
                    />
                  </div>
                }
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={instructionsId}>Instructions</Label>
                <p className="text-xs text-muted-foreground">
                  Saved as <code>/shared/SPACE.md</code>, which every agent in the space reads.
                  Sandboxes pick up changes when they next start.
                </p>
                <Textarea
                  id={instructionsId}
                  className="min-h-32"
                  placeholder="Conventions, constraints and goals for this space."
                  value={draft.instructions}
                  onChange={(event) => {
                    const instructions = event.currentTarget.value;
                    setDraft((current) => ({ ...current, instructions }));
                  }}
                />
              </div>

              <Row
                label="Max parallel sandboxes"
                description="1–32. Lowering it only blocks new sandboxes."
                control={
                  <NumberField
                    min={1}
                    max={TrevizeSpaces.MAX_SPACE_ENVIRONMENTS}
                    value={draft.maxEnvironments}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        maxEnvironments: Math.min(
                          TrevizeSpaces.MAX_SPACE_ENVIRONMENTS,
                          Math.max(1, Math.round(value ?? 1)),
                        ),
                      }))
                    }
                    aria-label="Max parallel sandboxes"
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label="Fewer sandboxes" />
                      <NumberFieldInput />
                      <NumberFieldIncrement aria-label="More sandboxes" />
                    </NumberFieldGroup>
                  </NumberField>
                }
              />
            </fieldset>
            {/* Lets Enter in the name field save. */}
            <button type="submit" hidden />
          </form>

          <div className="mt-6 flex items-center justify-between gap-6 border-t border-border pt-6">
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium">Archive space</div>
              <p className="text-xs text-muted-foreground">
                Hides the space and stops its sandboxes. Trevize keeps its history and{" "}
                <code>/shared</code> files.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                void archiveSpace(space).then((archived) => {
                  if (archived) onClose();
                });
              }}
            >
              <ArchiveIcon />
              Archive
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Spinner size="sm" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
