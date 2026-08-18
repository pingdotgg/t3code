import { CloudIcon, MonitorIcon } from "lucide-react";
import { memo } from "react";

import type { EnvironmentOption } from "./BranchToolbar.logic";

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
    <span
      className="flex min-w-0 flex-col gap-1 py-0.5"
      data-machine-profile-row
      aria-label={`${environment.label}: ${environment.workspaceRoot}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvironmentIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{environment.label}</span>
        {unavailable ? (
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Unavailable
          </span>
        ) : null}
      </span>
      <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-tight text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Path</span>
        <span className="min-w-0 truncate" aria-label={environment.workspaceRoot}>
          {environment.workspaceRoot}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Checkout
        </span>
        <span className="min-w-0 truncate" aria-label={profile.branchLabel}>
          {profile.branchLabel}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Workspace
        </span>
        <span className="min-w-0 truncate" aria-label={profile.workspaceLabel}>
          {profile.workspaceLabel}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">Model</span>
        <span className="min-w-0 truncate" aria-label={profile.modelLabel}>
          {profile.modelLabel}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Provider
        </span>
        <span className="min-w-0 truncate" aria-label={profile.providerLabel}>
          {profile.providerLabel}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Settings
        </span>
        <span className="min-w-0 truncate" aria-label={profile.executionLabel}>
          {profile.executionLabel}
        </span>
      </span>
    </span>
  );
});
