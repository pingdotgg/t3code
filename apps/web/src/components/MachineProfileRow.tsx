import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function TruncatedMachineValue({ value, className }: { value: string; className: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{value}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-[min(36rem,calc(100vw-2rem))] wrap-anywhere">
        {value}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface MachineProfileRowProps {
  environment: Pick<
    EnvironmentOption,
    "label" | "isPrimary" | "workspaceRoot" | "connection" | "profile"
  >;
}

export const MachineProfileRow = memo(function MachineProfileRow({
  environment,
}: MachineProfileRowProps) {
  const EnvironmentIcon = environment.isPrimary ? MonitorIcon : CloudIcon;
  const unavailable = environment.connection !== "connected";
  const profile = environment.profile;

  return (
    <span className="flex min-w-0 flex-col gap-1 py-0.5" data-machine-profile-row>
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvironmentIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <TruncatedMachineValue value={environment.label} className="min-w-0 truncate font-medium" />
        {unavailable ? (
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Unavailable
          </span>
        ) : null}
      </span>
      <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-tight text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Path</span>
        <TruncatedMachineValue value={environment.workspaceRoot} className="min-w-0 truncate" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Checkout
        </span>
        <TruncatedMachineValue value={profile.branchLabel} className="min-w-0 truncate" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Workspace
        </span>
        <TruncatedMachineValue value={profile.workspaceLabel} className="min-w-0 truncate" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Model</span>
        <TruncatedMachineValue value={profile.modelLabel} className="min-w-0 truncate" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Provider
        </span>
        <TruncatedMachineValue value={profile.providerLabel} className="min-w-0 truncate" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Settings
        </span>
        <TruncatedMachineValue value={profile.executionLabel} className="min-w-0 truncate" />
      </span>
    </span>
  );
});
