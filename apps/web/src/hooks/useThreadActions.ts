import { parseScopedThreadKey, scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import {
  type OrchestrationThreadShell,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@forma/contracts";
import type { ThreadCleanupInactiveDays } from "@forma/contracts/settings";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { stageOptimisticThreadShell } from "../environments/runtime/service";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { newCommandId, newThreadId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsForProjectRefs,
  selectThreadByRef,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { bucketThreadsForCleanup } from "../lib/threadCleanup";
import { useSettings } from "./useSettings";
import { buildForkedThreadTitle } from "../threadForking";

type ArchiveDispatchResult =
  | { status: "archived"; projectRef: ScopedProjectRef; threadRef: ScopedThreadRef }
  | { status: "not-found" | "skipped-queued" | "skipped-running"; threadRef: ScopedThreadRef };

function formatThreadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

function formatCleanupSummaryParts(input: {
  skippedRunningCount: number;
  skippedQueuedCount: number;
  failedCount: number;
}): string[] {
  return [
    ...(input.skippedRunningCount > 0
      ? [`${formatThreadCount(input.skippedRunningCount)} running`]
      : []),
    ...(input.skippedQueuedCount > 0
      ? [`${formatThreadCount(input.skippedQueuedCount)} queued`]
      : []),
    ...(input.failedCount > 0 ? [`${formatThreadCount(input.failedCount)} failed`] : []),
  ];
}

export function useThreadActions() {
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const router = useRouter();
  const { handleNewThread } = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;
  const queryClient = useQueryClient();

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const state = useStore.getState();
    const thread = selectThreadByRef(state, target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const dispatchArchiveThread = useCallback(
    async (input: {
      target: ScopedThreadRef;
      mode: "best-effort" | "strict";
    }): Promise<ArchiveDispatchResult> => {
      const api = readEnvironmentApi(input.target.environmentId);
      if (!api) {
        return {
          status: "not-found",
          threadRef: input.target,
        };
      }
      const resolved = resolveThreadTarget(input.target);
      if (!resolved) {
        return {
          status: "not-found",
          threadRef: input.target,
        };
      }
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        if (input.mode === "strict") {
          throw new Error("Cannot archive a running thread.");
        }
        return {
          status: "skipped-running",
          threadRef,
        };
      }
      if (input.mode === "best-effort" && thread.turnQueue.items.length > 0) {
        return {
          status: "skipped-queued",
          threadRef,
        };
      }

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });
      return {
        status: "archived",
        projectRef: scopeProjectRef(thread.environmentId, thread.projectId),
        threadRef,
      };
    },
    [resolveThreadTarget],
  );

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const result = await dispatchArchiveThread({
        target,
        mode: "strict",
      });

      if (
        result.status === "archived" &&
        currentRouteThreadRef?.threadId === result.threadRef.threadId &&
        currentRouteThreadRef.environmentId === result.threadRef.environmentId
      ) {
        await handleNewThreadRef.current(result.projectRef);
      }
    },
    [dispatchArchiveThread, getCurrentRouteThreadRef],
  );

  const cleanupInactiveThreads = useCallback(
    async (input: {
      inactiveDays: ThreadCleanupInactiveDays;
      projectDisplayName: string;
      projectRefs: readonly ScopedProjectRef[];
    }) => {
      const buckets = bucketThreadsForCleanup({
        threads: selectSidebarThreadsForProjectRefs(useStore.getState(), input.projectRefs),
        inactiveDays: input.inactiveDays,
      });
      let archivedCount = 0;
      let skippedRunningCount = buckets.skippedRunning.length;
      let skippedQueuedCount = buckets.skippedQueued.length;
      let failedCount = 0;
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const currentRouteProjectRef = currentRouteThreadRef
        ? (() => {
            const resolvedCurrentRoute = resolveThreadTarget(currentRouteThreadRef);
            return resolvedCurrentRoute
              ? scopeProjectRef(
                  resolvedCurrentRoute.thread.environmentId,
                  resolvedCurrentRoute.thread.projectId,
                )
              : null;
          })()
        : null;
      let archivedCurrentRouteThread = false;

      for (const thread of buckets.eligible) {
        const isCurrentRouteThread =
          currentRouteThreadRef?.threadId === thread.id &&
          currentRouteThreadRef.environmentId === thread.environmentId;
        try {
          const result = await dispatchArchiveThread({
            target: scopeThreadRef(thread.environmentId, thread.id),
            mode: "best-effort",
          });
          switch (result.status) {
            case "archived":
              archivedCount += 1;
              if (isCurrentRouteThread) {
                archivedCurrentRouteThread = true;
              }
              break;
            case "skipped-running":
              skippedRunningCount += 1;
              break;
            case "skipped-queued":
              skippedQueuedCount += 1;
              break;
            case "not-found":
              failedCount += 1;
              break;
          }
        } catch {
          failedCount += 1;
        }
      }

      if (archivedCurrentRouteThread && currentRouteProjectRef) {
        await handleNewThreadRef.current(currentRouteProjectRef);
      }

      const detailParts = formatCleanupSummaryParts({
        skippedRunningCount,
        skippedQueuedCount,
        failedCount,
      });
      const detail =
        detailParts.length > 0
          ? `Skipped ${detailParts.join(", ")} in ${input.projectDisplayName}.`
          : archivedCount > 0
            ? `Cleaned up ${input.projectDisplayName}.`
            : `No eligible inactive threads remained in ${input.projectDisplayName}.`;
      if (archivedCount > 0) {
        toastManager.add(
          stackedThreadToast({
            type: failedCount > 0 ? "warning" : "success",
            title: `Archived ${formatThreadCount(archivedCount)}`,
            description: detail,
          }),
        );
      } else {
        toastManager.add(
          stackedThreadToast({
            type: failedCount > 0 || detailParts.length > 0 ? "warning" : "info",
            title: "No inactive threads archived",
            description: detail,
          }),
        );
      }

      return {
        archivedCount,
        eligibleCount: buckets.eligible.length,
        failedCount,
        skippedQueuedCount,
        skippedRunningCount,
      };
    },
    [dispatchArchiveThread, getCurrentRouteThreadRef, resolveThreadTarget],
  );

  const unarchiveThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
  }, []);

  const forkThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        throw new Error("Environment API not found.");
      }
      const resolved = resolveThreadTarget(target);
      if (!resolved) {
        throw new Error("Source thread not found.");
      }

      const nextThreadId = newThreadId();
      const nextThreadRef = scopeThreadRef(target.environmentId, nextThreadId);
      const createdAt = new Date().toISOString();
      await api.orchestration.dispatchCommand({
        type: "thread.fork",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: target.threadId,
        createdAt,
      });

      const sourceSummary = selectSidebarThreadSummaryByRef(useStore.getState(), target);
      const placeholderThreadShell: OrchestrationThreadShell = {
        id: nextThreadId,
        projectId: resolved.thread.projectId,
        title: buildForkedThreadTitle(resolved.thread.title),
        modelSelection: resolved.thread.modelSelection,
        runtimeMode: resolved.thread.runtimeMode,
        interactionMode: resolved.thread.interactionMode,
        branch: resolved.thread.branch,
        worktreePath: resolved.thread.worktreePath,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        session: null,
        latestUserMessageAt: sourceSummary?.latestUserMessageAt ?? null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        queuedTurnCount: 0,
        turnQueueStatus: "idle",
      };

      stageOptimisticThreadShell(placeholderThreadShell, target.environmentId);

      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(nextThreadRef),
      });
    },
    [resolveThreadTarget, router],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, opts: { deletedThreadKeys?: ReadonlySet<string> } = {}) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread, threadRef } = resolved;
      const state = useStore.getState();
      const threads = selectThreadsForEnvironment(state, threadRef.environmentId);
      const threadProject = selectProjectByRef(state, {
        environmentId: threadRef.environmentId,
        projectId: thread.projectId,
      });
      const deletedIds =
        opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
          ? new Set<ThreadId>(
              [...opts.deletedThreadKeys].flatMap((threadKey) => {
                const ref = parseScopedThreadKey(threadKey);
                return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
              }),
            )
          : undefined;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        survivingThreads,
        threadRef.threadId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const localApi = readLocalApi();
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        localApi &&
        (await localApi.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: threadRef.threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId: threadRef.threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });
      clearComposerDraftForThread(threadRef);
      clearProjectDraftThreadById(
        scopeProjectRef(threadRef.environmentId, thread.projectId),
        threadRef,
      );
      clearTerminalState(threadRef);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          const fallbackThread = selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            });
          } else {
            await router.navigate({ to: "/", replace: true });
          }
        } else {
          await router.navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await ensureEnvironmentApi(threadRef.environmentId).git.removeWorktree({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
        await invalidateGitQueries(queryClient, {
          environmentId: threadRef.environmentId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId: threadRef.threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread deleted, but worktree removal failed",
            description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
          }),
        );
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      getCurrentRouteThreadRef,
      router,
      queryClient,
      resolveThreadTarget,
      sidebarThreadSortOrder,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread } = resolved;

      if (confirmThreadDelete && localApi) {
        const confirmed = await localApi.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return {
    archiveThread,
    cleanupInactiveThreads,
    unarchiveThread,
    forkThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
