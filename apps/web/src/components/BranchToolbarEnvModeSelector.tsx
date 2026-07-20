import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveEnvModeLabel,
  resolveWorkspaceSelection,
  type ExistingWorktreeOption,
  type EnvMode,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "./ui/select";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  existingWorktrees: readonly ExistingWorktreeOption[];
  mainCheckout: ExistingWorktreeOption | null;
  onExistingWorktreeChange: (worktree: ExistingWorktreeOption) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  existingWorktrees,
  mainCheckout,
  onExistingWorktreeChange,
}: BranchToolbarEnvModeSelectorProps) {
  const {
    isMainCheckout,
    selectedExistingWorktree,
    value: selectValue,
    label: selectedWorkspaceLabel,
  } = resolveWorkspaceSelection({
    effectiveEnvMode,
    activeWorktreePath,
    mainCheckout,
    existingWorktrees,
  });
  const envModeItems = useMemo(
    () => [
      {
        value: mainCheckout ? `main:${mainCheckout.path}` : "local",
        label: "Main checkout",
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...existingWorktrees.map((worktree) => ({
        value: `existing:${worktree.path}`,
        label: worktree.label,
      })),
    ],
    [existingWorktrees, mainCheckout],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {selectedExistingWorktree ? (
          <>
            <FolderGitIcon className="size-3" />
            {selectedExistingWorktree.label}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            Main checkout
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={selectValue}
      onValueChange={(value) => {
        if (mainCheckout && value === `main:${mainCheckout.path}`) {
          onExistingWorktreeChange(mainCheckout);
          return;
        }
        const existingWorktree = existingWorktrees.find(
          (worktree) => `existing:${worktree.path}` === value,
        );
        if (existingWorktree) {
          onExistingWorktreeChange(existingWorktree);
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
        {isMainCheckout ? (
          <FolderIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <span className="min-w-0 flex-1 truncate">{selectedWorkspaceLabel}</span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value={mainCheckout ? `main:${mainCheckout.path}` : "local"}>
            <span className="inline-flex items-center gap-1.5">
              {mainCheckout ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              Main checkout
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
            {existingWorktrees.map((worktree) => (
              <SelectItem key={worktree.path} value={`existing:${worktree.path}`}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <FolderGitIcon className="size-3 shrink-0" />
                  <span className="truncate">{worktree.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
