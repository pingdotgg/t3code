import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon, HistoryIcon } from "lucide-react";
import { memo, useMemo } from "react";
import type { VcsTerminology } from "@t3tools/shared/vcs";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceDisplayName,
  type EnvMode,
} from "./BranchToolbar.logic";
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

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  workspaceRoot?: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  displayMode?: "toolbar" | "panel";
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
  terminology: VcsTerminology;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  workspaceRoot = null,
  onEnvModeChange,
  displayMode = "toolbar",
  previousWorktreeLabel,
  onUsePreviousWorktree,
  terminology,
}: BranchToolbarEnvModeSelectorProps) {
  const workspacePath = displayMode === "panel" ? (activeWorktreePath ?? workspaceRoot) : null;
  const workspaceDisplayName = resolveWorkspaceDisplayName(workspacePath);
  const workspaceKind = activeWorktreePath ? terminology.workspaceNounTitle : "Project folder";
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () => [
      {
        value: "local",
        label:
          workspaceDisplayName ?? resolveCurrentWorkspaceLabel(activeWorktreePath, terminology),
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree", terminology) },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
    ],
    [
      activeWorktreePath,
      previousWorktreeLabel,
      showPreviousWorktree,
      terminology,
      workspaceDisplayName,
    ],
  );

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
      >
        {forceNewWorktree ? (
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
        <ComposerContextLabel displayMode={displayMode}>
          {forceNewWorktree
            ? resolveEnvModeLabel("worktree", terminology)
            : (workspaceDisplayName ??
              resolveLockedWorkspaceLabel(activeWorktreePath, terminology))}
        </ComposerContextLabel>
        {displayMode === "panel" ? (
          <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
            {forceNewWorktree ? terminology.workspaceNounTitle : workspaceKind}
          </span>
        ) : null}
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {forceNewWorktree
            ? `Each model starts in its own ${terminology.workspaceNoun}.`
            : (workspacePath ?? resolveLockedWorkspaceLabel(activeWorktreePath, terminology))}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size={displayMode === "panel" ? "default" : "xs"}
              className={cn(
                "min-w-0 shrink font-normal text-xs!",
                displayMode === "panel" && THREAD_DETAILS_PANEL_SELECT_ROW_CLASS,
              )}
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
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
          <ComposerContextLabel displayMode={displayMode}>
            <SelectValue />
          </ComposerContextLabel>
          {displayMode === "panel" ? (
            <span className="shrink-0 text-[10px] font-normal text-muted-foreground/70">
              {effectiveEnvMode === "worktree" && !activeWorktreePath ? "Create" : workspaceKind}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {workspacePath ??
            (effectiveEnvMode === "worktree"
              ? resolveEnvModeLabel("worktree", terminology)
              : resolveCurrentWorkspaceLabel(activeWorktreePath, terminology))}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...(displayMode === "toolbar" ? composerFloatingLayerProps : {})}
        {...(displayMode === "panel"
          ? {
              popupClassName: THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
            }
          : {})}
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath, terminology)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree", terminology)}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <span className="inline-flex items-center gap-1.5">
                <HistoryIcon className="size-3" />
                {previousWorktreeLabel}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
