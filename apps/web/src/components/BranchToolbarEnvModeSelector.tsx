import { ThreadDetailsSelectControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { BoxIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceDisplayName,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  workspaceRoot?: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The server can run new worktrees in Docker sandboxes. */
  sandboxesAvailable?: boolean;
  displayMode?: "toolbar" | "panel";
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  workspaceRoot = null,
  onEnvModeChange,
  sandboxesAvailable = false,
  displayMode = "toolbar",
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const workspacePath = displayMode === "panel" ? (activeWorktreePath ?? workspaceRoot) : null;
  const workspaceDisplayName = resolveWorkspaceDisplayName(workspacePath);
  // The panel names the workspace kind only when it is not the project folder.
  const workspaceKind = activeWorktreePath ? "Worktree" : null;
  const lockedWorkspaceKind = forceNewWorktree ? "Worktree" : workspaceKind;
  const selectWorkspaceKind =
    effectiveEnvMode !== "local" && !activeWorktreePath ? "Create" : workspaceKind;
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const NewWorkspaceIcon = effectiveEnvMode === "sandbox" ? BoxIcon : FolderGit2Icon;
  const envModeItems = useMemo(
    () => [
      {
        value: "local",
        label: workspaceDisplayName ?? resolveCurrentWorkspaceLabel(activeWorktreePath),
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...(sandboxesAvailable ? [{ value: "sandbox", label: resolveEnvModeLabel("sandbox") }] : []),
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
    ],
    [
      activeWorktreePath,
      previousWorktreeLabel,
      sandboxesAvailable,
      showPreviousWorktree,
      workspaceDisplayName,
    ],
  );

  const handleWorkspaceContextMenu = (event: ReactMouseEvent) => {
    if (!workspacePath || forceNewWorktree) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    void api.contextMenu
      .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((action) => {
        if (action !== "copy-path") return;
        void writeTextToClipboard(workspacePath, "workspace path").then(
          (didCopy) => {
            if (didCopy) {
              toastManager.add({
                type: "success",
                title: "Path copied",
                description: workspacePath,
              });
            }
          },
          (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to copy path",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          },
        );
      });
  };

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        data-composer-context-control
        onContextMenu={handleWorkspaceContextMenu}
      >
        {activeWorktreePath ? (
          <FolderGitIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : effectiveEnvMode !== "local" ? (
          <NewWorkspaceIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : (
          <FolderIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        )}
        <ComposerContextLabel displayMode={displayMode}>
          {forceNewWorktree
            ? resolveEnvModeLabel("worktree")
            : (workspaceDisplayName ??
              resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode))}
        </ComposerContextLabel>
        {displayMode === "panel" && lockedWorkspaceKind ? (
          <span className="shrink-0 text-3xs font-normal text-muted-foreground/70">
            {lockedWorkspaceKind}
          </span>
        ) : null}
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : (workspacePath ?? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode))}
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
            <ThreadDetailsSelectControl
              panel={displayMode === "panel"}
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
              onContextMenu={handleWorkspaceContextMenu}
            />
          }
        >
          {effectiveEnvMode !== "local" ? (
            <NewWorkspaceIcon
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
          {displayMode === "panel" && selectWorkspaceKind ? (
            <span className="shrink-0 text-3xs font-normal text-muted-foreground/70">
              {selectWorkspaceKind}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {workspacePath ??
            (effectiveEnvMode === "local"
              ? resolveCurrentWorkspaceLabel(activeWorktreePath)
              : resolveEnvModeLabel(effectiveEnvMode))}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...(displayMode === "toolbar" ? composerFloatingLayerProps : {})}
        className={
          displayMode === "panel"
            ? "w-(--anchor-width)"
            : showPreviousWorktree
              ? "w-[min(21rem,calc(100vw-2rem))]"
              : undefined
        }
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
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {sandboxesAvailable ? (
            <SelectItem value="sandbox">
              <span className="inline-flex items-center gap-1.5">
                <BoxIcon className="size-3" />
                {resolveEnvModeLabel("sandbox")}
              </span>
            </SelectItem>
          ) : null}
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
