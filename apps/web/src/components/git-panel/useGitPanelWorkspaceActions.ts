import type { GitCreateWorktreeResult, GitStatusResult, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { toastManager } from "~/components/ui/toast";
import { buildTemporaryWorktreeBranchName } from "~/gitWorktree";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { formatWorktreePathForDisplay } from "~/worktreeCleanup";
import { buildPrimaryWorkspaceResolutionPrompt } from "./GitPanel.logic";

interface UseGitPanelWorkspaceActionsInput {
  activeServerThreadSessionStatus: string | null;
  activeThreadBranch: string | null;
  activeThreadId: ThreadId | null;
  activeWorkspaceBranch: string | null;
  focusDraftThread: (branch: string, worktreePath: string) => Promise<void>;
  focusPrimaryWorkspaceDraft: () => Promise<ThreadId | null>;
  invalidateQueries: () => Promise<void>;
  isPrimaryWorkspace: boolean;
  persistThreadWorkspaceContext: (
    branch: string | null,
    worktreePath: string | null,
  ) => Promise<void>;
  primaryWorkspaceStatus: GitStatusResult | null;
  repoCwd: string | null;
  repoRoot: string | null;
  removeWorktree: (input: { cwd: string; path: string; force: boolean }) => Promise<unknown>;
  repoWorkspaceCwd: string | null;
  createWorktree: (input: {
    cwd: string;
    branch: string;
    newBranch: string;
  }) => Promise<GitCreateWorktreeResult>;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  threadToastData: { threadId: ThreadId } | undefined;
}

export function useGitPanelWorkspaceActions({
  activeServerThreadSessionStatus,
  activeThreadBranch,
  activeThreadId,
  activeWorkspaceBranch,
  focusDraftThread,
  focusPrimaryWorkspaceDraft,
  invalidateQueries,
  isPrimaryWorkspace,
  persistThreadWorkspaceContext,
  primaryWorkspaceStatus,
  repoCwd,
  repoRoot,
  removeWorktree,
  repoWorkspaceCwd,
  createWorktree,
  setPrompt,
  threadToastData,
}: UseGitPanelWorkspaceActionsInput) {
  const createDedicatedWorkspace = useCallback(async () => {
    if (!repoCwd || !activeWorkspaceBranch) {
      return;
    }

    try {
      const result = await createWorktree({
        cwd: repoCwd,
        branch: activeWorkspaceBranch,
        newBranch: buildTemporaryWorktreeBranchName(),
      });
      await focusDraftThread(result.worktree.branch, result.worktree.path);
      toastManager.add({
        type: "success",
        title: "Workspace created",
        description: formatWorktreePathForDisplay(result.worktree.path),
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to create workspace",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [activeWorkspaceBranch, createWorktree, focusDraftThread, repoCwd, threadToastData]);

  const closeDedicatedWorkspace = useCallback(
    async (discardChanges: boolean) => {
      if (!repoWorkspaceCwd || isPrimaryWorkspace || !repoCwd || !repoRoot || !activeThreadId) {
        return;
      }

      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Workspace controls unavailable",
          data: threadToastData,
        });
        return;
      }

      if (discardChanges) {
        const confirmed = await api.dialogs.confirm(
          [
            "Discard uncommitted changes and close this workspace?",
            formatWorktreePathForDisplay(repoWorkspaceCwd),
            "",
            "Committed branch history will be kept.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      if (activeServerThreadSessionStatus && activeServerThreadSessionStatus !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await removeWorktree({
          cwd: repoCwd,
          path: repoWorkspaceCwd,
          force: discardChanges,
        });

        let nextPrimaryBranch = activeThreadBranch ?? activeWorkspaceBranch ?? null;
        let branchActivatedInPrimary = false;
        if (nextPrimaryBranch) {
          try {
            await api.git.checkout({ cwd: repoRoot, branch: nextPrimaryBranch });
            branchActivatedInPrimary = true;
          } catch {
            const fallbackPrimaryStatus = await api.git.status({ cwd: repoRoot }).catch(() => null);
            nextPrimaryBranch = fallbackPrimaryStatus?.branch ?? nextPrimaryBranch;
          }
        }

        await invalidateQueries();
        await persistThreadWorkspaceContext(
          activeThreadBranch ?? activeWorkspaceBranch ?? null,
          null,
        );
        toastManager.add({
          type: branchActivatedInPrimary || !activeThreadBranch ? "success" : "warning",
          title: discardChanges ? "Workspace discarded" : "Workspace closed",
          description:
            branchActivatedInPrimary && nextPrimaryBranch
              ? `Branch ${nextPrimaryBranch} is active in the primary checkout.`
              : activeThreadBranch
                ? `Branch ${activeThreadBranch} is released. Clean the primary checkout before switching to it.`
                : "The primary checkout is active again.",
          data: threadToastData,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: discardChanges ? "Failed to discard workspace" : "Failed to close workspace",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      activeServerThreadSessionStatus,
      activeThreadBranch,
      activeThreadId,
      activeWorkspaceBranch,
      invalidateQueries,
      isPrimaryWorkspace,
      persistThreadWorkspaceContext,
      removeWorktree,
      repoCwd,
      repoRoot,
      repoWorkspaceCwd,
      threadToastData,
    ],
  );

  const openPrimaryWorkspaceResolutionDraft = useCallback(async () => {
    if (!repoRoot) {
      return;
    }
    const targetThreadId = await focusPrimaryWorkspaceDraft();
    if (!targetThreadId) {
      return;
    }
    setPrompt(
      targetThreadId,
      buildPrimaryWorkspaceResolutionPrompt({
        workspacePath: repoRoot,
        takeoverBranch: activeThreadBranch ?? activeWorkspaceBranch ?? null,
        conflictedFiles: primaryWorkspaceStatus?.merge.conflictedFiles ?? [],
        changedFiles: primaryWorkspaceStatus?.workingTree.files.map((file) => file.path) ?? [],
      }),
    );
    toastManager.add({
      type: "success",
      title: "Primary checkout opened",
      description: "The composer is prefilled with the blocking checkout details.",
      data: threadToastData,
    });
  }, [
    activeThreadBranch,
    activeWorkspaceBranch,
    focusPrimaryWorkspaceDraft,
    primaryWorkspaceStatus?.merge.conflictedFiles,
    primaryWorkspaceStatus?.workingTree.files,
    repoRoot,
    setPrompt,
    threadToastData,
  ]);

  return {
    closeDedicatedWorkspace,
    createDedicatedWorkspace,
    openPrimaryWorkspaceResolutionDraft,
  };
}
