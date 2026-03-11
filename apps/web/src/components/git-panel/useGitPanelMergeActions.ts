import type { GitAbortMergeResult, GitMergeBranchesResult, ThreadId } from "@t3tools/contracts";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toastManager } from "~/components/ui/toast";
import { buildResolveConflictPrompt } from "./GitPanel.logic";

interface UseGitPanelMergeActionsInput {
  activeTargetBranch: string | null;
  activeThreadId: ThreadId | null;
  activeWorkspaceBranch: string | null;
  conflictedFiles: readonly string[];
  lastMergeResult: GitMergeBranchesResult | null;
  mergeSourceBranch: string;
  mergeBranches: (input: {
    sourceBranch: string;
    targetBranch: string;
  }) => Promise<GitMergeBranchesResult>;
  abortMerge: (workspaceCwd: string) => Promise<GitAbortMergeResult>;
  setLastMergeResult: Dispatch<SetStateAction<GitMergeBranchesResult | null>>;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  threadToastData: { threadId: ThreadId } | undefined;
  workspaceCwd: string | null;
}

export function useGitPanelMergeActions({
  activeTargetBranch,
  activeThreadId,
  activeWorkspaceBranch,
  conflictedFiles,
  lastMergeResult,
  mergeSourceBranch,
  mergeBranches,
  abortMerge,
  setLastMergeResult,
  setPrompt,
  threadToastData,
  workspaceCwd,
}: UseGitPanelMergeActionsInput) {
  const runMergeFromBranch = useCallback(
    async (sourceBranch: string) => {
      if (!activeWorkspaceBranch || !sourceBranch) {
        return;
      }

      try {
        const result = await mergeBranches({
          sourceBranch,
          targetBranch: activeWorkspaceBranch,
        });
        setLastMergeResult(result);
        toastManager.add({
          type: result.status === "merged" ? "success" : "warning",
          title:
            result.status === "merged" ? `Merged ${result.sourceBranch}` : "Conflicts in merge",
          description:
            result.status === "merged"
              ? `Into ${result.targetBranch}`
              : `${result.conflictedFiles.length} file${result.conflictedFiles.length === 1 ? "" : "s"}`,
          data: threadToastData,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Merge failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [activeWorkspaceBranch, mergeBranches, setLastMergeResult, threadToastData],
  );

  const runLocalMerge = useCallback(async () => {
    if (!mergeSourceBranch) {
      return;
    }
    await runMergeFromBranch(mergeSourceBranch);
  }, [mergeSourceBranch, runMergeFromBranch]);

  const abortActiveMerge = useCallback(async () => {
    if (!workspaceCwd) {
      return;
    }

    try {
      const result = await abortMerge(workspaceCwd);
      if (result.status === "aborted") {
        setLastMergeResult(null);
      }
      toastManager.add({
        type: result.status === "aborted" ? "success" : "info",
        title: result.status === "aborted" ? "Merge aborted" : "No merge in progress",
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to abort",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [abortMerge, setLastMergeResult, threadToastData, workspaceCwd]);

  const createResolveConflictDraft = useCallback(() => {
    if (!activeThreadId || conflictedFiles.length === 0) {
      return;
    }
    const prompt = buildResolveConflictPrompt({
      workspacePath: workspaceCwd,
      sourceBranch: activeWorkspaceBranch,
      mergeSourceBranch:
        lastMergeResult?.sourceBranch ?? (mergeSourceBranch || activeTargetBranch || null),
      conflictedFiles,
    });
    setPrompt(activeThreadId, prompt);
    toastManager.add({
      type: "success",
      title: "Conflict resolution draft created",
      description: "The composer is prefilled with the current merge facts.",
      data: threadToastData,
    });
  }, [
    activeTargetBranch,
    activeThreadId,
    activeWorkspaceBranch,
    conflictedFiles,
    lastMergeResult?.sourceBranch,
    mergeSourceBranch,
    setPrompt,
    threadToastData,
    workspaceCwd,
  ]);

  return {
    abortActiveMerge,
    createResolveConflictDraft,
    runLocalMerge,
    runMergeFromBranch,
  };
}
