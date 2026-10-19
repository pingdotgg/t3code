import { ComposerControl, ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { CircleArrowUpIcon, ScaleIcon } from "lucide-react";
import { memo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import {
  ServerUpdateAction,
  type PendingServerUpdate,
  type ServerUpdateControl,
} from "./ServerUpdateAction";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
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
  serverUpdate?: PendingServerUpdate | null;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const UPDATE_VALUE = "action:update";
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector(
  props: BranchToolbarEnvironmentSelectorProps,
) {
  return props.serverUpdate ? (
    <ServerUpdateAction
      {...props.serverUpdate}
      render={(updateControl) => <EnvironmentSelector {...props} updateControl={updateControl} />}
    />
  ) : (
    <EnvironmentSelector {...props} updateControl={null} />
  );
});

function EnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  serverUpdate,
  updateControl,
}: BranchToolbarEnvironmentSelectorProps & {
  updateControl: ServerUpdateControl | null;
}) {
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
    ...(serverUpdate && updateControl
      ? [{ value: UPDATE_VALUE, label: `${updateControl.label} ${serverUpdate.serverLabel}` }]
      : []),
  ];
  const updateTooltip = serverUpdate
    ? `${serverUpdate.serverLabel} ${serverUpdate.serverVersion} → ${serverUpdate.targetVersion}. ${
        serverUpdate.selfUpdate === "desktop-managed" && !serverUpdate.desktopAppUpdate
          ? "Update the desktop app on that machine."
          : (updateControl?.label ?? "Update")
      }`
    : null;
  const environmentIcon = serverUpdate ? (
    <CircleArrowUpIcon aria-hidden="true" className="size-3 shrink-0" />
  ) : (
    <EnvironmentMachineIcon
      kind={activeEnvironment?.machine ?? "server"}
      className="size-3 shrink-0"
    />
  );
  const chipBody = (
    <>
      {environmentIcon}
      <ComposerContextLabel>
        {activeEnvironment?.label ?? serverUpdate?.serverLabel ?? "Run on"}
      </ComposerContextLabel>
    </>
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = updateControl ? (
      <ComposerControl
        size="xs"
        className="min-w-0 max-w-full"
        aria-label={`${updateControl.label} ${serverUpdate?.serverLabel}`}
        disabled={updateControl.disabled}
        onClick={updateControl.onClick}
        data-composer-context-control
      >
        {chipBody}
      </ComposerControl>
    ) : (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {chipBody}
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            updateControl?.disabled ? (
              <span className="inline-flex min-w-0 max-w-full" data-composer-context-control>
                {lockedRow}
              </span>
            ) : (
              lockedRow
            )
          }
        />
        <TooltipPopup role={serverUpdate ? "tooltip" : undefined}>
          {updateTooltip ?? activeEnvironment?.label ?? "Run on"}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? AUTO_VALUE : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === UPDATE_VALUE) {
          updateControl?.onClick();
        } else if (value === AUTO_VALUE) {
          onAutoEnvironment?.();
        } else if (value?.startsWith("env:")) {
          onEnvironmentChange(value.slice(4) as EnvironmentId);
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
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            environmentIcon
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup role={serverUpdate ? "tooltip" : undefined}>
          {updateTooltip ?? autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
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
            <SelectItem key={env.environmentId} value={environmentValue(env.environmentId)}>
              <span className="inline-flex items-center gap-1.5">
                {serverUpdate?.environmentId === env.environmentId ? (
                  <CircleArrowUpIcon aria-hidden="true" className="size-3" />
                ) : (
                  <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {serverUpdate && updateControl ? (
          <SelectGroup>
            <SelectGroupLabel>Server update</SelectGroupLabel>
            <SelectItem value={UPDATE_VALUE} disabled={updateControl.disabled}>
              <span className="inline-flex items-center gap-1.5">
                <CircleArrowUpIcon aria-hidden="true" className="size-3" />
                {updateControl.label} {serverUpdate.serverLabel}
              </span>
            </SelectItem>
          </SelectGroup>
        ) : null}
      </SelectPopup>
    </Select>
  );
}
