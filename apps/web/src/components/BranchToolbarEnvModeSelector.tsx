import type { EnvironmentId } from "@t3tools/contracts";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useWorktreeRenameTrigger } from "../hooks/useWorktreeRenameTrigger";
import { useWorktreeLabel } from "../uiStateStore";
import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
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

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  environmentId,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
}: BranchToolbarEnvModeSelectorProps) {
  const worktreeLabel = useWorktreeLabel(environmentId, activeWorktreePath);
  // Double-click or right-click the workspace label to rename the active
  // worktree (cosmetic label only). No-op when the thread isn't on a worktree.
  const renameTrigger = useWorktreeRenameTrigger(environmentId, activeWorktreePath);
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath, worktreeLabel) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
    ],
    [activeWorktreePath, worktreeLabel],
  );

  if (envLocked) {
    return (
      <span
        className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs"
        onDoubleClick={renameTrigger.onDoubleClick}
        onContextMenu={renameTrigger.onContextMenu}
        title={activeWorktreePath ? "Double-click or right-click to rename worktree" : undefined}
      >
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath, worktreeLabel)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath, worktreeLabel)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value) => onEnvModeChange(value as EnvMode)}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="font-medium"
        aria-label="Workspace"
        onDoubleClick={renameTrigger.onDoubleClick}
        onContextMenu={renameTrigger.onContextMenu}
        title={activeWorktreePath ? "Double-click or right-click to rename worktree" : undefined}
      >
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <SelectValue />
      </SelectTrigger>
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
              {resolveCurrentWorkspaceLabel(activeWorktreePath, worktreeLabel)}
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
