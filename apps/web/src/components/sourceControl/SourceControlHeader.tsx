/**
 * Compact repository toolbar modelled after VS Code's Source Control view.
 * Repository identity and branch state stay visible while search, graph,
 * refresh, sync and recovery actions remain one click away.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyStatusResult } from "@t3tools/contracts";
import type { ReactNode } from "react";
import {
  Archive,
  FolderGit2,
  GitBranch,
  GitGraph,
  ListTree,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Undo2,
} from "lucide-react";

import { deriveSyncState, trackingHint } from "~/lib/sourceControl/syncState";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { SourceControlSection } from "~/sourceControlStore";

export interface SourceControlHeaderProps {
  readonly status: WorkingCopyStatusResult | null;
  readonly repoLabel: string;
  readonly activeSection: SourceControlSection;
  readonly searchActive: boolean;
  readonly syncBusy: boolean;
  readonly pendingSyncKind: SourceControlSyncKind | null;
  /** Any source-control mutation is active; navigation/filter controls remain available. */
  readonly actionsBusy: boolean;
  readonly dirtyCount: number;
  readonly undoBusy: boolean;
  readonly discardAllBusy: boolean;
  readonly stashBusy: boolean;
  readonly refreshBusy: boolean;
  readonly viewActions: ReactNode;
  readonly onSelectSection: (section: SourceControlSection) => void;
  readonly onToggleSearch: () => void;
  readonly onSync: (kind: SourceControlSyncKind) => void;
  readonly onUndoLastCommit: () => void;
  readonly onDiscardAll: () => void;
  readonly onOpenStashDialog: () => void;
  readonly onOpenStashes: () => void;
  readonly onRefresh: () => void;
}

export type SourceControlSyncKind = "publish" | "push" | "pull" | "sync" | "fetch";

const PENDING_SYNC_LABEL: Record<SourceControlSyncKind, string> = {
  publish: "Publishing…",
  push: "Pushing…",
  pull: "Pulling…",
  sync: "Syncing…",
  fetch: "Refreshing…",
};

export function SourceControlHeader(props: SourceControlHeaderProps) {
  const sync = deriveSyncState(props.status);
  const hint = trackingHint(props.status, sync);
  const clean = props.dirtyCount === 0;
  const showingHistory = props.activeSection === "history";
  const refreshOnly = sync.kind === "fetch";
  const refreshBusy = props.refreshBusy || (refreshOnly && props.syncBusy);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-source-control-repository-header>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          }
        >
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-semibold">{props.repoLabel}</span>
              {props.dirtyCount > 0 ? (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {props.dirtyCount}
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11px] leading-3 text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">
                {props.status?.refName ??
                  (props.status?.detached
                    ? "detached HEAD"
                    : props.refreshBusy
                      ? "loading…"
                      : "no branch")}
              </span>
              {hint ? <span className="shrink-0 tabular-nums">{hint}</span> : null}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{props.repoLabel}</TooltipPopup>
      </Tooltip>

      <div className="flex shrink-0 items-center gap-0.5" aria-label="Source control toolbar">
        <ToolbarButton
          label={props.searchActive ? "Clear and close filter" : "Filter source control"}
          active={props.searchActive}
          onClick={props.onToggleSearch}
        >
          <Search />
        </ToolbarButton>
        {props.viewActions}
        <ToolbarButton
          label={showingHistory ? "Show changes" : "Show commit history"}
          active={showingHistory}
          onClick={() => props.onSelectSection(showingHistory ? "changes" : "history")}
        >
          {showingHistory ? <ListTree /> : <GitGraph />}
        </ToolbarButton>
        <ToolbarButton
          label={refreshBusy ? "Refreshing source control" : "Refresh source control"}
          disabled={refreshBusy || props.actionsBusy}
          onClick={() => (refreshOnly ? props.onSync("fetch") : props.onRefresh())}
        >
          <RefreshCw className={cn(refreshBusy && "animate-spin")} />
        </ToolbarButton>
        {refreshOnly ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="gap-1 px-1.5 text-[11px]"
                  disabled={props.actionsBusy || props.status === null}
                  aria-busy={props.syncBusy}
                  onClick={() => props.onSync(sync.kind)}
                />
              }
            >
              {props.syncBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <SyncIcon kind={sync.kind} />
              )}
              <span className="max-w-20 truncate">
                {props.pendingSyncKind ? PENDING_SYNC_LABEL[props.pendingSyncKind] : sync.label}
              </span>
            </TooltipTrigger>
            <TooltipPopup>{sync.title}</TooltipPopup>
          </Tooltip>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="More source control actions"
                disabled={props.actionsBusy}
              />
            }
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-52">
            <MenuItem
              onClick={props.onUndoLastCommit}
              disabled={props.actionsBusy || props.undoBusy}
            >
              <GitGraph />
              {props.undoBusy ? "Undoing…" : "Undo last commit"}
            </MenuItem>
            <MenuItem
              onClick={props.onOpenStashDialog}
              disabled={props.actionsBusy || clean || props.stashBusy}
            >
              <Archive />
              Stash changes…
            </MenuItem>
            <MenuItem onClick={props.onOpenStashes}>
              <Archive />
              Stashes &amp; backups…
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={props.onDiscardAll}
              disabled={props.actionsBusy || clean || props.discardAllBusy}
              className={cn(!clean && !props.discardAllBusy && "text-destructive-foreground")}
            >
              <Undo2 />
              {props.discardAllBusy ? "Discarding…" : "Discard all changes"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function ToolbarButton(props: {
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn(props.active && "bg-accent text-accent-foreground")}
            disabled={props.disabled}
            aria-label={props.label}
            aria-pressed={props.active}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SyncIcon({ kind }: { kind: ReturnType<typeof deriveSyncState>["kind"] }) {
  switch (kind) {
    case "pull":
    case "push":
    case "publish":
    case "sync":
    case "fetch":
      return <RefreshCw className="size-3.5" />;
  }
}
