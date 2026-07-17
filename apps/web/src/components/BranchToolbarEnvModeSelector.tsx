import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  EXISTING_WORKTREE_VALUE_PREFIX,
  type ExistingWorktreeOption,
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
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  existingWorktrees: readonly ExistingWorktreeOption[];
  onSelectExistingWorktree: (option: ExistingWorktreeOption) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  existingWorktrees,
  onSelectExistingWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...existingWorktrees.map((option) => ({
        value: `${EXISTING_WORKTREE_VALUE_PREFIX}${option.worktreePath}`,
        label: option.branch,
      })),
    ],
    [activeWorktreePath, existingWorktrees],
  );

  const handleValueChange = (value: string | null) => {
    if (value === null) return;
    if (value.startsWith(EXISTING_WORKTREE_VALUE_PREFIX)) {
      const worktreePath = value.slice(EXISTING_WORKTREE_VALUE_PREFIX.length);
      const option = existingWorktrees.find((entry) => entry.worktreePath === worktreePath);
      if (option) onSelectExistingWorktree(option);
      return;
    }
    onEnvModeChange(value as EnvMode);
  };

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
      value={effectiveEnvMode}
      onValueChange={handleValueChange}
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
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
        </SelectGroup>
        {existingWorktrees.length > 0 ? (
          <SelectGroup>
            <SelectGroupLabel>Existing worktrees</SelectGroupLabel>
            {existingWorktrees.map((option) => (
              <SelectItem
                key={option.worktreePath}
                value={`${EXISTING_WORKTREE_VALUE_PREFIX}${option.worktreePath}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <FolderGitIcon className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{option.branch}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/45">
                    {option.folderName}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
