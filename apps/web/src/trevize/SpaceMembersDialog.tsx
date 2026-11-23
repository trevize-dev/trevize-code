import { useEffect, useEffectEvent, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TrevizeSpaces, type TrevizeApi } from "@t3tools/client-runtime/trevize";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { create } from "zustand";

import * as Trevize from "./commands";
import { useSpaces, type Space } from "./Spaces";

import { useAuth } from "~/cloud/trevizeAccount";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { requestConfirmDialog } from "~/confirmDialog";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

type SpaceRole = TrevizeApi.TrevizeSpaceRole;
type SpaceVisibility = TrevizeApi.TrevizeSpaceVisibility;
type MemberLike = Pick<TrevizeApi.TrevizeSpaceMember, "userId" | "name" | "email" | "image">;

/** Opens a space's members from anywhere (space panel, space menu, command palette). */
const useSpaceMembersDialogStore = create<{
  readonly spaceId: string | null;
  readonly setSpaceId: (spaceId: string | null) => void;
}>((set) => ({ spaceId: null, setSpaceId: (spaceId) => set({ spaceId }) }));

export function openSpaceMembers(spaceId: string) {
  useSpaceMembersDialogStore.getState().setSpaceId(spaceId);
}

/** Toasts a failed Trevize call with the server's message (403, 400 and 409 carry one). */
function reportSpaceFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : m(msg("Trevize did not answer.")),
  });
}

/** The signed-in Trevize user's id, or null when unknown (e.g. signed in with an API key). */
export function useTrevizeUserId(): string | null {
  return useAuth().userId;
}

function useRoleLabels(): Record<SpaceRole, string> {
  const gt = useGT();
  return {
    owner: gt("Owner", { $context: "space role" }),
    member: gt("Member", { $context: "space role" }),
    viewer: gt("Viewer", { $context: "space role" }),
  };
}

export function SpaceRoleBadge({ role }: { readonly role: SpaceRole }) {
  const labels = useRoleLabels();
  return (
    <Badge size="sm" variant={role === "owner" ? "secondary" : "outline"}>
      {labels[role]}
    </Badge>
  );
}

/** A member's picture, else their initials. */
export function SpaceMemberAvatar({
  member,
  size = "sm",
}: {
  readonly member: MemberLike;
  readonly size?: "sm" | "md";
}) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const sizeClass = size === "md" ? "size-7 text-2xs" : "size-5 text-3xs";
  return member.image === null || failedImage === member.image ? (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground",
        sizeClass,
      )}
    >
      {TrevizeSpaces.spaceMemberInitials(member)}
    </span>
  ) : (
    <img
      aria-hidden
      alt=""
      src={member.image}
      loading="lazy"
      className={cn("shrink-0 rounded-full bg-muted object-cover", sizeClass)}
      onError={() => setFailedImage(member.image)}
    />
  );
}

export function SpaceVisibilityToggle(props: {
  readonly value: SpaceVisibility;
  readonly disabled: boolean;
  readonly onChange: (value: SpaceVisibility) => void;
}) {
  const gt = useGT();
  return (
    <ToggleGroup
      aria-label={gt("Who can see it")}
      className="w-full *:flex-1"
      disabled={props.disabled}
      value={[props.value]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "private" || value === "workspace") props.onChange(value);
      }}
    >
      <Toggle value="private">
        <T>Members only</T>
      </Toggle>
      <Toggle value="workspace">
        <T>Everyone in the workspace</T>
      </Toggle>
    </ToggleGroup>
  );
}

function RoleSelect(props: {
  readonly value: SpaceRole;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (role: SpaceRole) => void;
}) {
  const labels = useRoleLabels();
  return (
    <div className="w-36 shrink-0">
      <Select
        value={props.value}
        items={labels}
        disabled={props.disabled}
        onValueChange={(value) => {
          const role = TrevizeSpaces.SPACE_ROLES.find((candidate) => candidate === value);
          if (role !== undefined) props.onChange(role);
        }}
      >
        <SelectTrigger size="sm" aria-label={props.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {TrevizeSpaces.SPACE_ROLES.map((role) => (
            <SelectItem key={role} value={role}>
              {labels[role]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** Asks, leaves the space and goes home. Resolves to whether it left. */
export function useLeaveSpace(): (
  space: Pick<Space, "id" | "name">,
  userId: string,
) => Promise<boolean> {
  const navigate = useNavigate();
  const remove = useAtomCommand(Trevize.removeSpaceMember, {
    reportFailure: false,
  });
  return async (space, userId) => {
    const message = m(
      msg('Leave "{name}"?\nYou stop seeing it until an owner adds you again.', {
        name: space.name,
      }),
    );
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    const result = await remove({ spaceId: space.id, userId, leaving: true });
    if (result._tag === "Success") {
      await navigate({ to: "/" });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportSpaceFailure(m(msg("Could not leave space")), squashAtomCommandFailure(result));
    }
    return false;
  };
}

/** Mounted once in the chat layout; opened through `openSpaceMembers`. */
export function SpaceMembersDialogHost() {
  const spaceId = useSpaceMembersDialogStore((state) => state.spaceId);
  const setSpaceId = useSpaceMembersDialogStore((state) => state.setSpaceId);
  const { spaces } = useSpaces();
  const space = spaceId === null ? null : spaces.find((candidate) => candidate.id === spaceId);
  if (!space || !TrevizeSpaces.spaceHasMembers(space)) return null;
  return <SpaceMembersDialog key={space.id} space={space} onClose={() => setSpaceId(null)} />;
}

function SpaceMembersDialog(props: { readonly space: Space; readonly onClose: () => void }) {
  const { space, onClose } = props;
  const gt = useGT();
  const userId = useTrevizeUserId();
  const canManage = TrevizeSpaces.canManageSpace(space);
  const membersAtom = Trevize.spaceMembersAtom(space.id);
  const query = useEnvironmentQuery(membersAtom);
  const opened = useEnvironmentQueryRefresh(membersAtom);
  const refreshOnOpen = useEffectEvent(() => {
    if (!opened.isPending()) opened.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches Trevize's member list each time the dialog opens; the space panel may hold an older one
  useEffect(() => refreshOnOpen(), []);
  const members = TrevizeSpaces.sortSpaceMembers(query.data ?? []);
  const setMember = useAtomCommand(Trevize.setSpaceMember, {
    reportFailure: false,
  });
  const removeMember = useAtomCommand(Trevize.removeSpaceMember, {
    reportFailure: false,
  });
  const updateSpace = useAtomCommand(Trevize.updateSpace, {
    reportFailure: false,
  });
  const leaveSpace = useLeaveSpace();
  const [pending, setPending] = useState<string | null>(null);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const roleLabels = useRoleLabels();
  const visibility = TrevizeSpaces.spaceVisibility(space);

  const changeRole = async (member: TrevizeApi.TrevizeSpaceMember, role: SpaceRole) => {
    if (role === member.role) return;
    setPending(member.userId);
    const result = await setMember({
      spaceId: space.id,
      userId: member.userId,
      role,
    });
    setPending(null);
    if (result._tag === "Success") query.refresh();
    else if (!isAtomCommandInterrupted(result)) {
      reportSpaceFailure(m(msg("Could not change role")), squashAtomCommandFailure(result));
    }
  };

  const remove = async (member: TrevizeApi.TrevizeSpaceMember) => {
    setPending(member.userId);
    const result = await removeMember({
      spaceId: space.id,
      userId: member.userId,
      leaving: false,
    });
    setPending(null);
    if (result._tag === "Success") query.refresh();
    else if (!isAtomCommandInterrupted(result)) {
      reportSpaceFailure(m(msg("Could not remove member")), squashAtomCommandFailure(result));
    }
  };

  const changeVisibility = async (next: SpaceVisibility) => {
    if (next === visibility) return;
    if (next === "private") {
      const message = m(
        msg(
          'Make "{name}" members only?\nWorkspace members who aren\'t listed here lose access to it and its sandboxes.',
          { name: space.name },
        ),
      );
      const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
      if (!confirmed) return;
    }
    setSavingVisibility(true);
    const result = await updateSpace({
      spaceId: space.id,
      patch: { visibility: next },
    });
    setSavingVisibility(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportSpaceFailure(
        m(msg("Could not change who sees the space")),
        squashAtomCommandFailure(result),
      );
    }
  };

  const canLeave = TrevizeSpaces.canLeaveSpace(space, members, userId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Members</T>
          </DialogTitle>
          <DialogDescription>
            {canManage
              ? gt("Who can see and work in {name}.", { name: space.name })
              : gt("Only owners can change who is in {name}.", {
                  name: space.name,
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <section aria-label={gt("Who can see it")} className="space-y-2">
              <SpaceVisibilityToggle
                value={visibility}
                disabled={!canManage || savingVisibility}
                onChange={(next) => void changeVisibility(next)}
              />
              <p className="text-xs text-muted-foreground">
                {visibility === "workspace" ? (
                  <T>Everyone in the workspace can open it and works in it as a member.</T>
                ) : (
                  <T>Only the people listed here can see it.</T>
                )}{" "}
                <T>
                  Agents in shared spaces use the workspace Claude connection, not personal
                  subscriptions.
                </T>
              </p>
            </section>

            <section aria-label={gt("Members")} className="space-y-2">
              {query.error !== null && query.data === null ? (
                <p className="text-sm text-muted-foreground">{query.error}</p>
              ) : query.data === null ? (
                <Spinner size="sm" />
              ) : (
                <ul className="divide-y divide-border">
                  {members.map((member) => {
                    const label = TrevizeSpaces.spaceMemberLabel(member);
                    const lastOwner = TrevizeSpaces.isLastSpaceOwner(members, member.userId);
                    const busy = pending === member.userId;
                    return (
                      <li key={member.userId} className="flex items-center gap-3 py-2">
                        <SpaceMemberAvatar member={member} size="md" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">
                            {member.userId === userId ? gt("{name} (you)", { name: label }) : label}
                          </div>
                          {member.email && member.email !== label ? (
                            <div className="truncate text-xs text-muted-foreground">
                              {member.email}
                            </div>
                          ) : null}
                        </div>
                        {canManage ? (
                          <>
                            <RoleSelect
                              value={member.role}
                              disabled={busy || lastOwner}
                              label={gt("Role of {name}", { name: label })}
                              onChange={(role) => void changeRole(member, role)}
                            />
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={gt("Remove {name}", { name: label })}
                              disabled={busy || lastOwner}
                              onClick={() => void remove(member)}
                            >
                              {busy ? <Spinner size="xs" /> : <XIcon />}
                            </Button>
                          </>
                        ) : (
                          <SpaceRoleBadge role={member.role} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {canManage && query.data !== null ? (
              <AddPeople
                space={space}
                members={members}
                roleLabels={roleLabels}
                onAdded={query.refresh}
              />
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {canLeave && userId !== null ? (
            <Button
              size="sm"
              variant="ghost"
              className="sm:me-auto"
              onClick={() => {
                void leaveSpace(space, userId).then((left) => {
                  if (left) onClose();
                });
              }}
            >
              <T>Leave space</T>
            </Button>
          ) : null}
          <DialogClose render={<Button variant="outline" size="sm" />}>
            <T>Done</T>
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AddPeople(props: {
  readonly space: Space;
  readonly members: ReadonlyArray<TrevizeApi.TrevizeSpaceMember>;
  readonly roleLabels: Record<SpaceRole, string>;
  readonly onAdded: () => void;
}) {
  const gt = useGT();
  const workspace = useEnvironmentQuery(Trevize.workspaceMembersAtom(props.space.workspaceId));
  const setMember = useAtomCommand(Trevize.setSpaceMember, {
    reportFailure: false,
  });
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<SpaceRole>("member");
  const [adding, setAdding] = useState<string | null>(null);
  const candidates = TrevizeSpaces.spaceMemberCandidates(
    workspace.data ?? [],
    props.members,
    search,
  );

  const add = async (candidate: TrevizeApi.TrevizeWorkspaceMember) => {
    setAdding(candidate.userId);
    const result = await setMember({
      spaceId: props.space.id,
      userId: candidate.userId,
      role,
    });
    setAdding(null);
    if (result._tag === "Success") props.onAdded();
    else if (!isAtomCommandInterrupted(result)) {
      reportSpaceFailure(m(msg("Could not add member")), squashAtomCommandFailure(result));
    }
  };

  return (
    <section aria-label={gt("Add people")} className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        <T>Add people</T>
      </h3>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="search"
          placeholder={gt("Search by name or email")}
          aria-label={gt("Search workspace members")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <RoleSelect
          value={role}
          disabled={false}
          label={gt("Role for new members")}
          onChange={setRole}
        />
      </div>
      {workspace.error !== null && workspace.data === null ? (
        <p className="text-sm text-muted-foreground">{workspace.error}</p>
      ) : workspace.data === null ? (
        <Spinner size="sm" />
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim() ? (
            <T>No one in the workspace matches.</T>
          ) : (
            <T>Everyone in the workspace is already listed.</T>
          )}
        </p>
      ) : (
        <ul className="max-h-48 overflow-y-auto">
          {candidates.map((candidate) => {
            const label = TrevizeSpaces.spaceMemberLabel(candidate);
            return (
              <li key={candidate.userId} className="flex items-center gap-3 py-1.5">
                <SpaceMemberAvatar member={candidate} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{label}</div>
                  {candidate.email && candidate.email !== label ? (
                    <div className="truncate text-xs text-muted-foreground">{candidate.email}</div>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={gt("Add {name} as {role}", {
                    name: label,
                    role: props.roleLabels[role],
                  })}
                  disabled={adding !== null}
                  onClick={() => void add(candidate)}
                >
                  {adding === candidate.userId ? <Spinner size="xs" /> : null}
                  <T>Add</T>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
