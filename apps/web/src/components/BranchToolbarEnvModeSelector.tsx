import { FolderGit2Icon, FolderGitIcon, FolderIcon, PinIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolvePinnedBaseTitle,
  type EnvMode,
  type WorktreePinnedBase,
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

/**
 * Sentinel select value for the "Always for this project" action. Selecting
 * it never becomes the control's value — it's intercepted in onValueChange
 * and routed to an explicit settings write instead.
 */
const SET_PROJECT_DEFAULT_VALUE = "__set_project_default__";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  pinnedBase?: WorktreePinnedBase | null;
  /**
   * Mode the project's new threads default to today (after overrides). Used
   * to decide whether the "Always for this project" action is meaningful.
   */
  projectDefaultEnvMode?: EnvMode | null;
  onEnvModeChange: (mode: EnvMode) => void;
  /** Persist the current mode as this project's default (explicit write). */
  onSetProjectDefaultEnvMode?: (mode: EnvMode) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  pinnedBase,
  projectDefaultEnvMode,
  onEnvModeChange,
  onSetProjectDefaultEnvMode,
}: BranchToolbarEnvModeSelectorProps) {
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
    ],
    [activeWorktreePath],
  );
  const showSetProjectDefault =
    onSetProjectDefaultEnvMode !== undefined &&
    projectDefaultEnvMode != null &&
    effectiveEnvMode !== projectDefaultEnvMode;

  if (envLocked) {
    // Post-send the label states the outcome, not the intent: the pinned
    // base commit (and, on hover, its provenance) replaces "New worktree".
    const lockedTitle = resolvePinnedBaseTitle(pinnedBase ?? null);
    return (
      <span
        className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs"
        {...(lockedTitle ? { title: lockedTitle } : {})}
      >
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath, pinnedBase)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath, pinnedBase)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value) => {
        const selected = value as string;
        if (selected === SET_PROJECT_DEFAULT_VALUE) {
          onSetProjectDefaultEnvMode?.(effectiveEnvMode);
          return;
        }
        onEnvModeChange(selected as EnvMode);
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
          <SelectGroupLabel>Workspace · this draft only</SelectGroupLabel>
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
        {showSetProjectDefault ? (
          <SelectGroup>
            <SelectItem hideIndicator value={SET_PROJECT_DEFAULT_VALUE}>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <PinIcon className="size-3" />
                Always {resolveEnvModeLabel(effectiveEnvMode).toLowerCase()} for this project
              </span>
            </SelectItem>
          </SelectGroup>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
