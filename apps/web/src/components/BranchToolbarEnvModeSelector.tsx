import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceDisplayName,
  type EnvMode,
} from "./BranchToolbar.logic";
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

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  workspaceRoot?: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  displayMode?: "toolbar" | "panel";
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  workspaceRoot = null,
  onEnvModeChange,
  displayMode = "toolbar",
}: BranchToolbarEnvModeSelectorProps) {
  const workspacePath = displayMode === "panel" ? (activeWorktreePath ?? workspaceRoot) : null;
  const workspaceDisplayName = resolveWorkspaceDisplayName(workspacePath);
  const workspaceKind = activeWorktreePath ? "Worktree" : "Project folder";
  const envModeItems = useMemo(
    () => [
      {
        value: "local",
        label: workspaceDisplayName ?? resolveCurrentWorkspaceLabel(activeWorktreePath),
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
    ],
    [activeWorktreePath, workspaceDisplayName],
  );

  if (envLocked) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
      >
        {activeWorktreePath ? (
          <FolderGitIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : (
          <FolderIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {workspaceDisplayName ?? resolveLockedWorkspaceLabel(activeWorktreePath)}
        </span>
        {displayMode === "panel" ? (
          <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
            {workspaceKind}
          </span>
        ) : null}
      </span>
    );

    if (!workspacePath) return lockedRow;

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup side="left">{workspacePath}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value) => onEnvModeChange(value as EnvMode)}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size={displayMode === "panel" ? "default" : "xs"}
              className={cn(
                "font-medium",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ROW_CLASS,
              )}
              aria-label="Workspace"
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : activeWorktreePath ? (
            <FolderGitIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : (
            <FolderIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          )}
          <SelectValue />
          {displayMode === "panel" ? (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
              {effectiveEnvMode === "worktree" && !activeWorktreePath ? "Create" : workspaceKind}
            </span>
          ) : null}
        </TooltipTrigger>
        {workspacePath ? <TooltipPopup side="left">{workspacePath}</TooltipPopup> : null}
      </Tooltip>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
