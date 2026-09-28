import type { ThreadExecutionTarget } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, SettingsIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const CLOUD_SETUP_VALUE = "cloud-setup";

const TARGET_LABEL: Record<ThreadExecutionTarget, string> = { local: "Local", cloud: "Cloud" };
const TARGET_DESCRIPTION: Record<ThreadExecutionTarget, string> = {
  local: "The agent works in this project's checkout.",
  cloud: "The agent works in a cloud workspace cloned from GitHub.",
};

interface BranchToolbarExecutionTargetSelectorProps {
  envLocked: boolean;
  executionTarget: ThreadExecutionTarget;
  cloudAvailable: boolean;
  /** Why Cloud is unavailable, shown in place of its description. */
  cloudMessage?: string | undefined;
  onExecutionTargetChange: (target: ThreadExecutionTarget) => void;
  onCloudSetup: () => void;
}

export const BranchToolbarExecutionTargetSelector = memo(
  function BranchToolbarExecutionTargetSelector({
    envLocked,
    executionTarget,
    cloudAvailable,
    cloudMessage,
    onExecutionTargetChange,
    onCloudSetup,
  }: BranchToolbarExecutionTargetSelectorProps) {
    const composerFloatingLayerProps = useComposerMenuProps();
    const items = useMemo(
      () => [
        { value: "local", label: TARGET_LABEL.local },
        { value: "cloud", label: TARGET_LABEL.cloud },
        ...(cloudAvailable ? [] : [{ value: CLOUD_SETUP_VALUE, label: "Set up Cloud" }]),
      ],
      [cloudAvailable],
    );
    const Icon = executionTarget === "cloud" ? CloudIcon : LaptopIcon;

    if (envLocked) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
            data-composer-context-control
          >
            <Icon className="size-3 shrink-0" />
            <span
              data-composer-label
              className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
            >
              <span
                data-composer-label-motion
                className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
              >
                {TARGET_LABEL[executionTarget]}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipPopup>{TARGET_DESCRIPTION[executionTarget]}</TooltipPopup>
        </Tooltip>
      );
    }

    return (
      <Select
        modal={false}
        value={executionTarget}
        onValueChange={(value: string | null) => {
          if (value === CLOUD_SETUP_VALUE) {
            onCloudSetup();
            return;
          }
          if (value === "local" || value === "cloud") onExecutionTargetChange(value);
        }}
        items={items}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="ghost"
                size="xs"
                className="min-w-0 shrink"
                aria-label="Agent runs"
                data-composer-context-control
              />
            }
          >
            <Icon className="size-3" />
            <span
              data-composer-label
              className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
            >
              <span
                data-composer-label-motion
                className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
              >
                <SelectValue />
              </span>
            </span>
          </TooltipTrigger>
          <TooltipPopup>{TARGET_DESCRIPTION[executionTarget]}</TooltipPopup>
        </Tooltip>
        <SelectPopup
          alignItemWithTrigger={false}
          className="w-[min(18rem,calc(100vw-2rem))]"
          {...composerFloatingLayerProps}
        >
          <SelectGroup>
            <SelectGroupLabel>Agent runs</SelectGroupLabel>
            <SelectItem value="local">
              <span className="flex min-w-0 items-start gap-1.5">
                <LaptopIcon className="mt-0.5 size-3 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span>{TARGET_LABEL.local}</span>
                  <span className="text-muted-foreground text-xs">{TARGET_DESCRIPTION.local}</span>
                </span>
              </span>
            </SelectItem>
            <SelectItem value="cloud" disabled={!cloudAvailable}>
              <span className="flex min-w-0 items-start gap-1.5">
                <CloudIcon className="mt-0.5 size-3 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span>{TARGET_LABEL.cloud}</span>
                  <span className="text-muted-foreground text-xs">
                    {cloudAvailable
                      ? TARGET_DESCRIPTION.cloud
                      : (cloudMessage ?? "Cloud is not set up for this provider.")}
                  </span>
                </span>
              </span>
            </SelectItem>
            {cloudAvailable ? null : (
              <SelectItem value={CLOUD_SETUP_VALUE}>
                <span className="inline-flex items-center gap-1.5">
                  <SettingsIcon className="size-3" />
                  Set up Cloud
                </span>
              </SelectItem>
            )}
          </SelectGroup>
        </SelectPopup>
      </Select>
    );
  },
);
