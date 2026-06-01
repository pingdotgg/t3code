import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveLockedWorkspaceLabel,
  resolveWorktreeModeLabel,
  type EnvMode,
  type WorktreeMode,
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
  effectiveEnvMode: EnvMode;
  worktreeMode: WorktreeMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onWorktreeModeChange: (mode: WorktreeMode) => void;
}

type WorkspaceSelectValue = "local" | "worktree:newBranch" | "worktree:existingBranch";

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  worktreeMode,
  activeWorktreePath,
  onEnvModeChange,
  onWorktreeModeChange,
}: BranchToolbarEnvModeSelectorProps) {
  const workspaceValue: WorkspaceSelectValue =
    effectiveEnvMode === "worktree" ? `worktree:${worktreeMode}` : "local";
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree:newBranch", label: resolveWorktreeModeLabel("newBranch") },
      { value: "worktree:existingBranch", label: resolveWorktreeModeLabel("existingBranch") },
    ],
    [activeWorktreePath],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={workspaceValue}
      onValueChange={(value) => {
        if (value === "local") {
          onEnvModeChange("local");
          return;
        }
        if (value === "worktree:newBranch") {
          onWorktreeModeChange("newBranch");
          onEnvModeChange("worktree");
          return;
        }
        if (value === "worktree:existingBranch") {
          onWorktreeModeChange("existingBranch");
          onEnvModeChange("worktree");
        }
      }}
      items={envModeItems}
    >
      <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
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
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree:newBranch">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveWorktreeModeLabel("newBranch")}
            </span>
          </SelectItem>
          <SelectItem value="worktree:existingBranch">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveWorktreeModeLabel("existingBranch")}
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
