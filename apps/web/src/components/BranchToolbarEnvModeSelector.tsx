import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { SelectedModelBadge } from "./chat/SelectedModelBadge";
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
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
}: BranchToolbarEnvModeSelectorProps) {
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
    ],
    [activeWorktreePath],
  );

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3 shrink-0" />
            <span>{resolveLockedWorkspaceLabel(activeWorktreePath)}</span>
          </>
        ) : (
          <>
            <FolderIcon className="size-3 shrink-0" />
            <span>{resolveLockedWorkspaceLabel(activeWorktreePath)}</span>
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
      <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3 shrink-0" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3 shrink-0" />
        ) : (
          <FolderIcon className="size-3 shrink-0" />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local" hideIndicator className="ps-2 pe-2">
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3 shrink-0" />
                ) : (
                  <FolderIcon className="size-3 shrink-0" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
              {effectiveEnvMode === "local" ? <SelectedModelBadge /> : null}
            </div>
          </SelectItem>
          <SelectItem value="worktree" hideIndicator className="ps-2 pe-2">
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <FolderGit2Icon className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
              {effectiveEnvMode === "worktree" ? <SelectedModelBadge /> : null}
            </div>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
