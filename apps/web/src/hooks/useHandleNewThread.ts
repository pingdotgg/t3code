import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { useStore } from "../store";
import { useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";

export function useHandleNewThread() {
  const projectIds = useStore(useShallow((store) => store.projects.map((project) => project.id)));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useThreadById(routeThreadId);
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projectIds,
      preferredIds: projectOrder,
      getId: (projectId) => projectId,
    });
  }, [projectIds, projectOrder]);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        applyStickyState,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }

      clearProjectDraftThreadId(projectId);

      if (
        latestActiveDraftThread &&
        routeThreadId &&
        latestActiveDraftThread.projectId === projectId
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(threadId);

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [navigate, routeThreadId],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectId: orderedProjects[0] ?? null,
    handleNewThread,
    routeThreadId,
  };
}
