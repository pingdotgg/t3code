import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { newCommandId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { resolveDraftEnvModeAfterBranchChange } from "../BranchToolbar.logic";

interface DraftThreadLookupResult {
  threadId: ThreadId;
  worktreePath: string | null;
}

interface DraftThreadContextInput {
  branch: string | null;
  worktreePath: string | null;
  envMode: "local" | "worktree";
}

interface UseGitPanelThreadRoutingInput {
  activeDraftThreadProjectId: ProjectId | null;
  activeDraftThreadWorktreePath: string | null;
  activeProjectId: ProjectId | null;
  activeServerThread: boolean;
  activeThreadId: ThreadId | null;
  activeThreadBranch: string | null;
  activeWorkspaceBranch: string | null;
  activeWorktreePath: string | null;
  effectiveEnvMode: "local" | "worktree";
  getDraftThreadByProjectId: (projectId: ProjectId) => DraftThreadLookupResult | null;
  hasServerThread: boolean;
  navigateToThread: (threadId: ThreadId) => Promise<void>;
  setDraftThreadContext: (threadId: ThreadId, input: DraftThreadContextInput) => void;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    input: DraftThreadContextInput,
  ) => void;
  setThreadBranchAction: (
    threadId: ThreadId,
    branch: string | null,
    worktreePath: string | null,
  ) => void;
}

export function useGitPanelThreadRouting({
  activeDraftThreadProjectId,
  activeDraftThreadWorktreePath,
  activeProjectId,
  activeServerThread,
  activeThreadId,
  activeThreadBranch,
  activeWorkspaceBranch,
  activeWorktreePath,
  effectiveEnvMode,
  getDraftThreadByProjectId,
  hasServerThread,
  navigateToThread,
  setDraftThreadContext,
  setProjectDraftThreadId,
  setThreadBranchAction,
}: UseGitPanelThreadRoutingInput) {
  const focusDraftThread = useCallback(
    async (branch: string, worktreePath: string) => {
      if (!activeProjectId) {
        return;
      }

      if (!activeServerThread && activeThreadId && activeDraftThreadProjectId === activeProjectId) {
        setDraftThreadContext(activeThreadId, {
          branch,
          worktreePath,
          envMode: "worktree",
        });
        return;
      }

      const existingDraftThread = getDraftThreadByProjectId(activeProjectId);
      const targetThreadId = existingDraftThread?.threadId ?? newThreadId();
      setProjectDraftThreadId(activeProjectId, targetThreadId, {
        branch,
        worktreePath,
        envMode: "worktree",
      });
      if (targetThreadId !== activeThreadId) {
        await navigateToThread(targetThreadId);
      }
    },
    [
      activeDraftThreadProjectId,
      activeProjectId,
      activeServerThread,
      activeThreadId,
      getDraftThreadByProjectId,
      navigateToThread,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const focusPrimaryWorkspaceDraft = useCallback(async () => {
    if (!activeProjectId) {
      return null;
    }

    const existingDraftThread = getDraftThreadByProjectId(activeProjectId);
    const canReuseActiveDraft =
      !activeServerThread &&
      activeThreadId !== null &&
      activeDraftThreadProjectId === activeProjectId &&
      activeDraftThreadWorktreePath === null;
    const targetThreadId = canReuseActiveDraft
      ? activeThreadId
      : existingDraftThread?.worktreePath === null
        ? existingDraftThread.threadId
        : newThreadId();

    if (!targetThreadId) {
      return null;
    }

    setProjectDraftThreadId(activeProjectId, targetThreadId, {
      branch: activeThreadBranch ?? activeWorkspaceBranch ?? null,
      worktreePath: null,
      envMode: "local",
    });

    if (targetThreadId !== activeThreadId) {
      await navigateToThread(targetThreadId);
    }

    return targetThreadId;
  }, [
    activeDraftThreadProjectId,
    activeDraftThreadWorktreePath,
    activeProjectId,
    activeServerThread,
    activeThreadBranch,
    activeThreadId,
    activeWorkspaceBranch,
    getDraftThreadByProjectId,
    navigateToThread,
    setProjectDraftThreadId,
  ]);

  const persistThreadWorkspaceContext = useCallback(
    async (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) {
        return;
      }

      const api = readNativeApi();
      if (api && hasServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }

      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }

      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(activeThreadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      activeWorktreePath,
      effectiveEnvMode,
      hasServerThread,
      setDraftThreadContext,
      setThreadBranchAction,
    ],
  );

  return {
    focusDraftThread,
    focusPrimaryWorkspaceDraft,
    persistThreadWorkspaceContext,
  };
}
