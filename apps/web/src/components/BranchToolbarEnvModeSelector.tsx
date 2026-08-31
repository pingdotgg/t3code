import { ChevronDownIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo } from "react";
import type { VcsWorktree } from "@t3tools/contracts";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { ExistingWorktreesMenuSub } from "./ExistingWorktreesMenuSub";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  existingWorktrees: ReadonlyArray<VcsWorktree>;
  onUseExistingWorktree: (worktree: VcsWorktree) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  existingWorktrees,
  onUseExistingWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  if (envLocked) {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        {resolveLockedWorkspaceLabel(activeWorktreePath)}
      </span>
    );
  }

  const workspaceLabel =
    effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="xs" />}
        className="min-w-0 shrink font-medium [--control-icon-color:currentColor]"
        aria-label="Workspace"
        data-composer-context-control
      >
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {workspaceLabel}
          </span>
        </span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          >
            <MenuRadioItem value="local">
              <span className="inline-flex items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                {resolveCurrentWorkspaceLabel(activeWorktreePath)}
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                {resolveEnvModeLabel("worktree")}
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {existingWorktrees.length > 0 ? <MenuSeparator /> : null}
        <ExistingWorktreesMenuSub
          worktrees={existingWorktrees}
          disabled={false}
          onSelect={onUseExistingWorktree}
        />
      </MenuPopup>
    </Menu>
  );
});
