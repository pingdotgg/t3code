import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { useStore } from "../store";

interface OpenProjectThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
}

function latestThreadIdForProject(
  projectId: ProjectId,
  threadIdsByProject: ReadonlyArray<{ id: ThreadId; projectId: ProjectId; createdAt: string }>,
): ThreadId | null {
  const latestThread = threadIdsByProject
    .filter((thread) => thread.projectId === projectId)
    .toSorted((left, right) => {
      const byDate = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      if (byDate !== 0) return byDate;
      return right.id.localeCompare(left.id);
    })[0];

  return latestThread?.id ?? null;
}

export function useProjectThreadNavigation(routeThreadId: ThreadId | null) {
  const threads = useStore((store) => store.threads);
  const navigate = useNavigate();
  const getDraftThreadByProjectId = useComposerDraftStore((store) => store.getDraftThreadByProjectId);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore((store) => store.clearProjectDraftThreadId);

  const navigateToThread = useCallback(
    async (threadId: ThreadId) => {
      if (routeThreadId === threadId) return;
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [navigate, routeThreadId],
  );

  const openOrCreateThread = useCallback(
    async (projectId: ProjectId, options?: OpenProjectThreadOptions) => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);

      if (storedDraftThread) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(storedDraftThread.threadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, storedDraftThread.threadId);
        await navigateToThread(storedDraftThread.threadId);
        return;
      }

      clearProjectDraftThreadId(projectId);

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (activeDraftThread && routeThreadId && activeDraftThread.projectId === projectId) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return;
      }

      const nextThreadId = newThreadId();
      setProjectDraftThreadId(projectId, nextThreadId, {
        createdAt: new Date().toISOString(),
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: options?.envMode ?? "local",
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });

      await navigateToThread(nextThreadId);
    },
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigateToThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const openProject = useCallback(
    async (projectId: ProjectId) => {
      const latestThreadId = latestThreadIdForProject(projectId, threads);
      if (latestThreadId) {
        await navigateToThread(latestThreadId);
        return;
      }

      const draftThread = getDraftThreadByProjectId(projectId);
      if (draftThread) {
        setProjectDraftThreadId(projectId, draftThread.threadId);
        await navigateToThread(draftThread.threadId);
        return;
      }

      await openOrCreateThread(projectId);
    },
    [getDraftThreadByProjectId, navigateToThread, openOrCreateThread, setProjectDraftThreadId, threads],
  );

  return {
    openOrCreateThread,
    openProject,
  };
}
