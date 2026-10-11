import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  applyRunOnSelection,
  CLOUD_RUN_VALUE,
  type CloudRunOption,
  type EnvironmentOption,
} from "./BranchToolbar.logic";
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
  cloudRun?: CloudRunOption | undefined;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  cloudRun,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
      ...(cloudRun ? [{ value: CLOUD_RUN_VALUE, label: cloudRun.label }] : []),
    ],
    [availableEnvironments, autoEnvironmentLabel, cloudRun, onAutoEnvironment],
  );
  const runOnLabel = cloudRun?.selected
    ? cloudRun.label
    : (autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on");
  const runOnIcon = cloudRun?.selected ? (
    <CloudIcon className="size-3 shrink-0" aria-hidden="true" />
  ) : autoEnvironmentLabel ? (
    <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
  ) : (
    <EnvironmentMachineIcon
      kind={activeEnvironment?.machine ?? "server"}
      className="size-3 shrink-0"
    />
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked || (onEnvironmentChange === undefined && cloudRun?.onChange === undefined)) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {runOnIcon}
        <ComposerContextLabel>{runOnLabel}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{runOnLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={cloudRun?.selected ? CLOUD_RUN_VALUE : autoEnvironmentLabel ? "auto" : environmentId}
      onValueChange={(value) =>
        applyRunOnSelection({
          value: String(value),
          environmentId,
          cloudRun,
          onAutoEnvironment,
          onEnvironmentChange,
        })
      }
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
          {runOnIcon}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{runOnLabel}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value="auto"
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
              value={env.environmentId}
              disabled={env.environmentId !== environmentId && !onEnvironmentChange}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {cloudRun ? (
            <SelectItem
              value={CLOUD_RUN_VALUE}
              disabled={!cloudRun.onChange}
              onClick={() => {
                if (cloudRun.selected) cloudRun.onChange?.(true);
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <CloudIcon className="size-3" aria-hidden="true" />
                {cloudRun.label}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
