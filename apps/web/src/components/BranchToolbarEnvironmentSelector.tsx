import type { EnvironmentId } from "@t3tools/contracts";
import { CircleArrowUpIcon, ScaleIcon } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useMemo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ServerUpdateAction, useServerUpdateTrigger } from "./ServerUpdateAction";
import { useComposerMenuProps } from "./chat/composerEventScope";
import type { ServerUpdateAvailability } from "./serverUpdateAvailability";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

// Select values are plain strings, and EnvironmentId is any non-empty string,
// so the picker's two non-environment rows get their own namespace and every
// environment value is prefixed. Nothing a server could mint collides.
const AUTO_VALUE = "action:auto";
const UPDATE_SERVER_VALUE = "action:update-server";
const environmentValue = (environmentId: EnvironmentId) => `env:${environmentId}`;
const environmentIdFromValue = (value: string | null) =>
  value?.startsWith("env:") ? (value.slice(4) as EnvironmentId) : null;

/**
 * The environment picker with the update as its last row. The picker's own
 * value never changes to that row; picking it runs the update and the Select
 * keeps the environment that was already selected.
 */
function ServerUpdateSelectItem({
  label,
  serverLabel,
  disabled = false,
}: {
  readonly label: string;
  readonly serverLabel: string;
  /** No remote path: the row explains the arrow and takes no click. */
  readonly disabled?: boolean;
}) {
  return (
    <SelectItem value={UPDATE_SERVER_VALUE} disabled={disabled}>
      <span className="inline-flex items-center gap-1.5">
        <CircleArrowUpIcon aria-hidden="true" className="size-3 text-foreground" />
        {label} {serverLabel}
      </span>
    </SelectItem>
  );
}

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  /**
   * An update waiting on the active server. An up arrow takes the machine
   * icon's place while it is pending, and where the chip is not a picker the
   * chip itself becomes the update action.
   */
  serverUpdate?: ServerUpdateAvailability | null;
}

/**
 * The chip when it is a label, not a control. It carries the xs control's
 * height (h-7 sm:h-6) and padding: the composer context strip has no
 * min-height of its own, and the glass seam joining it to the composer assumes
 * a fixed strip height, so a shorter label would drag the seam out of line
 * whenever this label is the only thing in the strip.
 */
function StaticChip({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6",
        className,
      )}
    />
  );
}

/** Icon plus the collapsible label every chip shares. */
function ChipBody({ icon, label }: { readonly icon: ReactNode; readonly label: string }) {
  return (
    <>
      {icon}
      <span data-composer-label className={CHIP_LABEL_CLASS}>
        <span data-composer-label-motion className={CHIP_LABEL_MOTION_CLASS}>
          {label}
        </span>
      </span>
    </>
  );
}

const CHIP_LABEL_CLASS = "min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0";
const CHIP_LABEL_MOTION_CLASS =
  "block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none";

function updateTooltip(update: ServerUpdateAvailability) {
  const versions = `${update.serverLabel} runs ${update.serverVersion}, this client is ${update.targetVersion}.`;
  if (update.selfUpdate === "desktop-managed" && !update.desktopAppUpdate) {
    return `${versions} Update the desktop app on that machine.`;
  }
  return update.selfUpdate === null
    ? `${versions} Click to copy the update command.`
    : `${versions} Click to update.`;
}

/**
 * The server chip while an update is pending. The arrow is the notice. The
 * chip is the action, except when the only path is a desktop app the server
 * cannot update for you, where it stays a label with the tooltip.
 */
function ServerUpdateChip({
  update,
  label,
}: {
  readonly update: ServerUpdateAvailability;
  readonly label: string;
}) {
  const body = (
    <ChipBody
      icon={<CircleArrowUpIcon aria-hidden="true" className="size-3 shrink-0 text-foreground" />}
      label={label}
    />
  );
  const actionable = !(update.selfUpdate === "desktop-managed" && !update.desktopAppUpdate);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex min-w-0 max-w-full" data-composer-context-control />}
      >
        {actionable ? (
          <ServerUpdateAction
            environmentId={update.environmentId}
            serverLabel={update.serverLabel}
            selfUpdate={update.selfUpdate}
            desktopAppUpdate={update.desktopAppUpdate}
            threadContinuation={update.threadContinuation}
            targetVersion={update.targetVersion}
            variant="ghost-muted"
            size="xs"
            className="min-w-0 max-w-full font-normal text-xs!"
          >
            {body}
          </ServerUpdateAction>
        ) : (
          <StaticChip>{body}</StaticChip>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{updateTooltip(update)}</TooltipPopup>
    </Tooltip>
  );
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  serverUpdate = null,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  // A fixed hook call: the target falls back to the active environment with no
  // update so the hook count never changes while the picker is mounted.
  const serverUpdateTrigger = useServerUpdateTrigger(
    serverUpdate ?? {
      environmentId,
      serverLabel: activeEnvironment?.label ?? "",
      selfUpdate: null,
      targetVersion: "",
    },
  );
  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: environmentValue(env.environmentId),
        label: env.label,
      })),
      ...(serverUpdate
        ? [{ value: UPDATE_SERVER_VALUE, label: activeEnvironment?.label ?? "" }]
        : []),
    ],
    [
      activeEnvironment?.label,
      availableEnvironments,
      autoEnvironmentLabel,
      onAutoEnvironment,
      serverUpdate,
    ],
  );

  if (envLocked || onEnvironmentChange === undefined) {
    const label = activeEnvironment?.label ?? "Run on";
    if (serverUpdate) {
      return <ServerUpdateChip update={serverUpdate} label={label} />;
    }
    return (
      <StaticChip data-composer-context-control>
        <ChipBody
          icon={
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          }
          label={label}
        />
      </StaticChip>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? AUTO_VALUE : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === UPDATE_SERVER_VALUE) {
          void serverUpdateTrigger.trigger();
          return;
        }
        if (value === AUTO_VALUE) {
          onAutoEnvironment?.();
          return;
        }
        const nextEnvironmentId = environmentIdFromValue(value);
        if (nextEnvironmentId !== null) onEnvironmentChange(nextEnvironmentId);
      }}
      items={environmentItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-full font-normal text-xs!"
        aria-label="Run on"
        data-composer-shortcut="composer.host"
        data-composer-context-control
      >
        {autoEnvironmentLabel ? (
          <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : serverUpdate ? (
          <CircleArrowUpIcon aria-hidden="true" className="size-3 shrink-0 text-foreground" />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
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
                  <CircleArrowUpIcon aria-hidden="true" className="size-3 text-foreground" />
                ) : (
                  <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                )}
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {serverUpdate ? (
          <>
            <SelectSeparator />
            <ServerUpdateSelectItem
              label={
                serverUpdateTrigger.actionable
                  ? serverUpdateTrigger.label
                  : "Update the desktop app on"
              }
              serverLabel={serverUpdate.serverLabel}
              disabled={!serverUpdateTrigger.actionable}
            />
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
