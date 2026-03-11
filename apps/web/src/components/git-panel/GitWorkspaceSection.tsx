import type { GitBranch, GitStatusResult } from "@t3tools/contracts";
import { DownloadIcon, FolderGit2Icon, GitCommitIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { formatWorktreePathForDisplay } from "~/worktreeCleanup";
import {
  buildCommitToBranchLabel,
  resolveCommitToBranchDisabledReason,
  resolveDedicatedWorkspaceActionState,
  type WorkspaceStatusLevel,
} from "./GitPanel.logic";
import { GitPanelSection } from "./GitPanelSection";
import { GitWorkspaceCard } from "./GitWorkspaceCard";
import {
  resolveCreateWorktreeDisabledReason,
  resolvePrimaryWorkspaceNeedsAttention,
  resolveSyncFromTargetDisabledReason,
} from "./GitWorkspaceSection.logic";

interface GitWorkspaceSectionProps {
  workspaceCwd: string;
  repoCwd: string | null;
  activeProjectId: string | null;
  activeThreadId: string | null;
  activeThreadBranch: string | null;
  activeWorkspaceBranch: string | null;
  activeWorkspaceBranchMeta: GitBranch | null;
  activeTargetBranch: string | null;
  gitStatus: GitStatusResult | null;
  primaryWorkspaceStatus: GitStatusResult | null;
  primaryWorkspaceStatusErrorMessage: string | null;
  isPrimaryWorkspace: boolean;
  hasConflicts: boolean;
  mergeInProgress: boolean;
  isGitActionRunning: boolean;
  isMerging: boolean;
  isCreatingWorktree: boolean;
  isRemovingWorktree: boolean;
  statusInfo: { level: WorkspaceStatusLevel; label: string };
  onOpenWorkspace: () => void;
  onCreateDedicatedWorkspace: () => void | Promise<void>;
  onOpenCommitDialog: () => void;
  onSyncFromTarget: () => void | Promise<void>;
  onCloseWorkspace: () => void | Promise<void>;
  onDiscardAndCloseWorkspace: () => void | Promise<void>;
  onPreparePrimaryCheckout: () => void | Promise<void>;
}

export function GitWorkspaceSection({
  workspaceCwd,
  repoCwd,
  activeProjectId,
  activeThreadId,
  activeThreadBranch,
  activeWorkspaceBranch,
  activeWorkspaceBranchMeta,
  activeTargetBranch,
  gitStatus,
  primaryWorkspaceStatus,
  primaryWorkspaceStatusErrorMessage,
  isPrimaryWorkspace,
  hasConflicts,
  mergeInProgress,
  isGitActionRunning,
  isMerging,
  isCreatingWorktree,
  isRemovingWorktree,
  statusInfo,
  onOpenWorkspace,
  onCreateDedicatedWorkspace,
  onOpenCommitDialog,
  onSyncFromTarget,
  onCloseWorkspace,
  onDiscardAndCloseWorkspace,
  onPreparePrimaryCheckout,
}: GitWorkspaceSectionProps) {
  const createWorktreeDisabledReason = resolveCreateWorktreeDisabledReason({
    isPrimaryWorkspace,
    activeProjectId,
    gitStatus,
    repoCwd,
    activeWorkspaceBranch,
    isCreating: isCreatingWorktree,
  });
  const commitToBranchDisabledReason = resolveCommitToBranchDisabledReason({
    gitStatus,
    hasConflicts,
    isBusy: isGitActionRunning,
  });
  const syncFromTargetDisabledReason = resolveSyncFromTargetDisabledReason({
    activeTargetBranch,
    activeWorkspaceBranch,
    gitStatus,
    hasConflicts,
    mergeInProgress,
    isMerging,
  });
  const dedicatedWorkspaceActionState = resolveDedicatedWorkspaceActionState({
    gitStatus,
    hasConflicts,
    mergeInProgress,
    isClosing: isRemovingWorktree,
    hasRepoContext: repoCwd !== null,
    hasThreadContext: activeThreadId !== null,
  });
  const primaryWorkspaceNeedsAttention =
    resolvePrimaryWorkspaceNeedsAttention(primaryWorkspaceStatus);

  return (
    <GitPanelSection title="Workspace">
      <GitWorkspaceCard
        isPrimary={isPrimaryWorkspace}
        name={
          isPrimaryWorkspace || !workspaceCwd
            ? "Primary checkout"
            : formatWorktreePathForDisplay(workspaceCwd)
        }
        branch={activeWorkspaceBranch ?? "Detached HEAD"}
        targetBranch={activeTargetBranch}
        path={workspaceCwd}
        statusLevel={statusInfo.level}
        statusLabel={statusInfo.label}
        aheadCount={gitStatus?.aheadCount ?? 0}
        behindCount={gitStatus?.behindCount ?? 0}
        hasOpenPr={gitStatus?.pr?.state === "open"}
        isDefaultBranch={activeWorkspaceBranchMeta?.isDefault ?? false}
        onOpen={onOpenWorkspace}
      />
      {isPrimaryWorkspace && (
        <Button
          variant="outline"
          size="sm"
          disabled={createWorktreeDisabledReason !== null}
          onClick={() => void onCreateDedicatedWorkspace()}
          className="w-full justify-start"
        >
          <FolderGit2Icon className="size-4" />
          Create dedicated workspace
          {createWorktreeDisabledReason && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {createWorktreeDisabledReason}
            </span>
          )}
        </Button>
      )}
      {!isPrimaryWorkspace && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <Button
            variant="default"
            size="sm"
            disabled={commitToBranchDisabledReason !== null}
            onClick={onOpenCommitDialog}
            className="w-full justify-center"
          >
            <GitCommitIcon className="size-4" />
            {buildCommitToBranchLabel(activeThreadBranch ?? activeWorkspaceBranch ?? null)}
          </Button>
          {commitToBranchDisabledReason && (
            <p className="text-center text-xs text-muted-foreground">
              {commitToBranchDisabledReason}
            </p>
          )}
          {activeTargetBranch && activeTargetBranch !== activeWorkspaceBranch && (
            <div className="space-y-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={syncFromTargetDisabledReason !== null}
                onClick={() => void onSyncFromTarget()}
                className="w-full justify-center"
              >
                <DownloadIcon className="size-4" />
                Sync from {activeTargetBranch}
              </Button>
              {syncFromTargetDisabledReason ? (
                <p className="text-center text-xs text-muted-foreground">
                  {syncFromTargetDisabledReason}
                </p>
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  Merge the target branch into this workspace before closing it.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-1.5 sm:grid-cols-2">
            <Button
              variant="outline"
              size="sm"
              disabled={dedicatedWorkspaceActionState.closeDisabledReason !== null}
              onClick={() => void onCloseWorkspace()}
              className="w-full justify-center"
            >
              <FolderGit2Icon className="size-4" />
              Close workspace
            </Button>
            {dedicatedWorkspaceActionState.showDiscardAction && (
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={dedicatedWorkspaceActionState.discardDisabledReason !== null}
                onClick={() => void onDiscardAndCloseWorkspace()}
                className="w-full justify-center"
              >
                Discard changes and close
              </Button>
            )}
          </div>
          {primaryWorkspaceNeedsAttention && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onPreparePrimaryCheckout()}
              className="w-full justify-center"
            >
              Prepare primary checkout
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {dedicatedWorkspaceActionState.closeDisabledReason ??
              "Close the dedicated checkout once changes are committed to the branch."}
          </p>
          {primaryWorkspaceStatusErrorMessage && (
            <p className="text-xs text-destructive-foreground">
              {primaryWorkspaceStatusErrorMessage}
            </p>
          )}
        </div>
      )}
    </GitPanelSection>
  );
}
