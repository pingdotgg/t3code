/**
 * Repo / branch line, the ONE contextual sync button, and the overflow menu.
 *
 * Branch *management* deliberately does not live here — the existing
 * `BranchToolbar` already owns creating, renaming, merging and deleting
 * branches, and duplicating it would give the app two places that disagree
 * about what the current branch is. The panel shows the branch and links out.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyStatusResult } from "@t3tools/contracts";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  GitBranch,
  History,
  MoreHorizontal,
  RefreshCw,
  Undo2,
} from "lucide-react";

import { deriveSyncState, trackingHint } from "~/lib/sourceControl/syncState";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface SourceControlHeaderProps {
  readonly status: WorkingCopyStatusResult | null;
  readonly repoLabel: string;
  readonly syncBusy: boolean;
  readonly dirtyCount: number;
  /** fork: f4 F-06 — overflow rungs disable while their own action is in flight. */
  readonly undoBusy: boolean;
  readonly discardAllBusy: boolean;
  readonly stashBusy: boolean;
  readonly refreshBusy: boolean;
  readonly onSync: (kind: "publish" | "push" | "pull" | "sync" | "fetch") => void;
  readonly onUndoLastCommit: () => void;
  readonly onDiscardAll: () => void;
  readonly onOpenStashDialog: () => void;
  readonly onShowBackups: () => void;
  readonly onRefresh: () => void;
}

export function SourceControlHeader(props: SourceControlHeaderProps) {
  const sync = deriveSyncState(props.status);
  const hint = trackingHint(props.status, sync);
  const clean = props.dirtyCount === 0;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">
                {props.status?.refName ?? (props.status?.detached ? "detached HEAD" : "no branch")}
              </span>
              {hint ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{hint}</span>
              ) : null}
            </span>
          }
        />
        <TooltipPopup>{props.repoLabel}</TooltipPopup>
      </Tooltip>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant={sync.emphasis ? "default" : "outline"}
                disabled={props.syncBusy}
                onClick={() => props.onSync(sync.kind)}
              >
                <SyncIcon kind={sync.kind} />
                {sync.label}
              </Button>
            }
          />
          <TooltipPopup>{sync.title}</TooltipPopup>
        </Tooltip>

        <Menu>
          <MenuTrigger
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Source control actions"
          >
            <MoreHorizontal className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-52">
            <MenuItem onClick={props.onRefresh} disabled={props.refreshBusy}>
              <RefreshCw />
              {props.refreshBusy ? "Refreshing…" : "Refresh"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={props.onUndoLastCommit} disabled={props.undoBusy}>
              <History />
              {props.undoBusy ? "Undoing…" : "Undo last commit"}
            </MenuItem>
            <MenuItem onClick={props.onOpenStashDialog} disabled={clean || props.stashBusy}>
              <Archive />
              Stash changes…
            </MenuItem>
            <MenuItem onClick={props.onShowBackups}>
              <Archive />
              Recent backups
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={props.onDiscardAll}
              disabled={clean || props.discardAllBusy}
              className={cn(!clean && !props.discardAllBusy && "text-destructive-foreground")}
            >
              <Undo2 />
              {props.discardAllBusy ? "Discarding…" : "Discard all changes in the working copy"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function SyncIcon({ kind }: { kind: ReturnType<typeof deriveSyncState>["kind"] }) {
  switch (kind) {
    case "pull":
      return <ArrowDown className="size-3.5" />;
    case "push":
    case "publish":
      return <ArrowUp className="size-3.5" />;
    case "sync":
      return <RefreshCw className="size-3.5" />;
    case "fetch":
      return <RefreshCw className="size-3.5" />;
  }
}
