import { ComposerControl } from "./chat/ComposerControl";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ComposerContextLabel } from "./ComposerContextLabel";
import {
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  SquareCheckIcon,
  SquareIcon,
} from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BranchToolbarWorktreeToggleProps {
  displayMode?: "toolbar" | "panel";
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
}

/**
 * The "New worktree" checkbox for a thread that has not started yet. Checked
 * creates a new worktree on send; unchecked runs in the current checkout or
 * the draft's existing worktree. Once the workspace is fixed it renders a
 * read-only label instead.
 */
export const BranchToolbarWorktreeToggle = memo(function BranchToolbarWorktreeToggle({
  displayMode = "toolbar",
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
}: BranchToolbarWorktreeToggleProps) {
  const isPanel = displayMode === "panel";
  const iconClassName = isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3";

  if (envLocked || forceNewWorktree) {
    // The panel shows the fixed workspace in its Run context row.
    if (isPanel) return null;
    const LockedIcon = activeWorktreePath
      ? FolderGitIcon
      : effectiveEnvMode === "worktree"
        ? FolderGit2Icon
        : FolderIcon;
    const lockedLabel = forceNewWorktree
      ? resolveEnvModeLabel("worktree")
      : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
              data-composer-context-control
            />
          }
        >
          <LockedIcon className="size-3" />
          <ComposerContextLabel>{lockedLabel}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {forceNewWorktree ? "Each model starts in its own worktree." : lockedLabel}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const checked = effectiveEnvMode === "worktree" && !activeWorktreePath;
  const CheckIcon = checked ? SquareCheckIcon : SquareIcon;
  const label = resolveEnvModeLabel("worktree");
  const toggleProps = {
    role: "checkbox",
    "aria-checked": checked,
    "data-composer-context-control": true,
    "data-composer-shortcut": "composer.workspace",
    onClick: () => onEnvModeChange(checked ? "local" : "worktree"),
    // Keep the composer's outside-press handling from treating a right or
    // ctrl click as a composer blur.
    onMouseDownCapture: (event: ReactMouseEvent) => {
      if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
    },
  } as const;

  if (isPanel) {
    return (
      <ThreadDetailsControl {...toggleProps}>
        <CheckIcon className={iconClassName} />
        <ComposerContextLabel displayMode="panel">{label}</ComposerContextLabel>
      </ThreadDetailsControl>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<ComposerControl size="xs" className="min-w-0 shrink" {...toggleProps} />}
      >
        <CheckIcon className={iconClassName} />
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>
        {checked ? "Starts in a new worktree" : resolveCurrentWorkspaceLabel(activeWorktreePath)}
      </TooltipPopup>
    </Tooltip>
  );
});
