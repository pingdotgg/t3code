import type { EnvironmentId } from "@t3tools/contracts";
import { CircleAlertIcon, CircleArrowUpIcon, CircleCheckIcon, GitForkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuItem } from "../ui/sidebar";
import {
  canCancelSourceUpdate,
  canPullUpstream,
  canRunSourceUpdate,
  isSourceUpdateSettled,
  newCommitsLabel,
  type SourceUpdatePhase,
  sourceUpdatePillLabel,
  unbuiltCommitsLabel,
} from "./sourceUpdate.logic";
import {
  dismissSourceUpdateOutcome,
  refreshSourceUpdateStatus,
  useSourceUpdateActions,
  useSourceUpdateEnvironmentId,
  useSourceUpdateState,
} from "./useSourceUpdate";

function PhaseIcon({ phase }: { readonly phase: SourceUpdatePhase }) {
  const className = "size-4 shrink-0";
  if (phase.kind === "failed")
    return <CircleAlertIcon className={cn(className, "text-destructive")} />;
  if (phase.kind === "succeeded") return <CircleCheckIcon className={className} />;
  if (phase.kind === "available" && phase.behindOrigin === 0 && phase.unbuilt === 0) {
    return <GitForkIcon className={className} />;
  }
  return <CircleArrowUpIcon className={cn(className, phase.kind === "running" && "opacity-60")} />;
}

/** Update and Pull upstream for a server that runs from a git checkout. */
export function SidebarSourceUpdatePill() {
  const environmentId = useSourceUpdateEnvironmentId();
  return environmentId === null ? null : <SourceUpdatePill environmentId={environmentId} />;
}

function SourceUpdatePill({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { status, phase } = useSourceUpdateState(environmentId);
  const { update, cancel, pullUpstream } = useSourceUpdateActions();
  const label = sourceUpdatePillLabel(phase);
  if (label === null) return null;

  return (
    <SidebarMenuItem className="ml-auto flex min-w-0 flex-1">
      <Menu
        onOpenChange={(open) => {
          if (open) refreshSourceUpdateStatus(environmentId);
        }}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full bg-sidebar-control-surface px-3 text-sidebar-foreground text-xs outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
                phase.kind === "failed" && "ring-1 ring-destructive/40 ring-inset",
              )}
            />
          }
        >
          <PhaseIcon phase={phase} />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          {status ? (
            <div className="max-w-64 truncate px-2 py-1.5 text-muted-foreground text-xs">
              Checkout at {status.head.sha} {status.head.subject}
            </div>
          ) : null}
          {phase.kind === "failed" ? (
            <div className="max-w-64 px-2 py-1.5 text-destructive text-xs">{phase.message}</div>
          ) : null}
          {phase.kind === "succeeded" && phase.message ? (
            <div className="max-w-64 px-2 py-1.5 text-muted-foreground text-xs">
              {phase.message}
            </div>
          ) : null}
          {canCancelSourceUpdate(phase) ? (
            <MenuItem onClick={() => void cancel(environmentId)}>Cancel update</MenuItem>
          ) : null}
          {canRunSourceUpdate(status, phase) ? (
            <MenuItem onClick={() => void update(environmentId)}>
              {phase.kind === "failed" ? "Retry update" : "Update and restart"}
              {status?.behindOrigin ? (
                <MenuItemDetail>{newCommitsLabel(status.behindOrigin)}</MenuItemDetail>
              ) : status?.unbuiltCommits ? (
                <MenuItemDetail>{unbuiltCommitsLabel(status.unbuiltCommits)}</MenuItemDetail>
              ) : null}
            </MenuItem>
          ) : null}
          {canPullUpstream(status, phase) ? (
            <MenuItem onClick={() => void pullUpstream(environmentId)}>
              Pull upstream
              <MenuItemDetail>{newCommitsLabel(status?.upstreamAhead ?? 0)}</MenuItemDetail>
            </MenuItem>
          ) : null}
          {isSourceUpdateSettled(phase) ? (
            <MenuItem onClick={() => dismissSourceUpdateOutcome(environmentId, phase)}>
              Dismiss
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
