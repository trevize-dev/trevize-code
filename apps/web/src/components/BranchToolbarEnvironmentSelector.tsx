import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, PlusIcon, ScaleIcon } from "lucide-react";
import { memo } from "react";

import { ADD_TO_MACHINE_LABEL_CLASS, type EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { CONNECT_CLOUD_SELECT_VALUE, CloudItemContent, cloudSelectValue } from "./CloudItemContent";
import { openTrevizePage, type CloudPlacement } from "../trevize/cloudSessions";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
  /** Offers "Cloud": this is a draft of a project Trevize Cloud can run. */
  cloud?: CloudPlacement | null;
  /** The draft starts in the cloud instead of on a machine. */
  cloudSelected?: boolean;
  /** Picks the cloud, or leaves it when the user picks a machine. */
  onCloudSelectedChange?: (selected: boolean) => void;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const ADD_MACHINE_VALUE = "action:add-machine";
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
  cloud = null,
  cloudSelected = false,
  onCloudSelectedChange,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;

  const environmentItems = [
    ...(onAutoEnvironment
      ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? "Auto balance" }]
      : []),
    ...availableEnvironments.map((env) => ({
      value: environmentValue(env.environmentId),
      label: env.label,
    })),
    ...(cloud
      ? [
          {
            value: cloudSelectValue(cloud),
            label: cloud.workspaceName ? `Cloud · ${cloud.workspaceName}` : "Cloud",
          },
        ]
      : []),
    ...(onAddToMachine ? [{ value: ADD_MACHINE_VALUE, label: "Add to another machine" }] : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (
    envLocked ||
    (onEnvironmentChange === undefined && onAddToMachine === undefined && cloud === null)
  ) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={
        cloudSelected
          ? "cloud"
          : autoEnvironmentLabel
            ? AUTO_VALUE
            : environmentValue(environmentId)
      }
      onValueChange={(value) => {
        if (value === ADD_MACHINE_VALUE) {
          onAddToMachine?.();
        } else if (value === CONNECT_CLOUD_SELECT_VALUE) {
          if (cloud?.connectUrl) openTrevizePage(cloud.connectUrl);
        } else if (value === "cloud") {
          onCloudSelectedChange?.(true);
        } else {
          if (cloudSelected) onCloudSelectedChange?.(false);
          if (value === AUTO_VALUE) {
            onAutoEnvironment?.();
          } else if (value?.startsWith("env:") && value.slice(4) !== environmentId) {
            onEnvironmentChange?.(value.slice(4) as EnvironmentId);
          }
        }
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {cloudSelected ? (
            <CloudIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {cloudSelected ? "Cloud" : (autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on")}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value={AUTO_VALUE}
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={onEnvironmentChange === undefined && env.environmentId !== environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {cloud ? (
            <SelectItem value={cloudSelectValue(cloud)}>
              <CloudItemContent placement={cloud} />
            </SelectItem>
          ) : null}
          {onAddToMachine ? (
            <SelectItem value={ADD_MACHINE_VALUE}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                Add to another machine
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
