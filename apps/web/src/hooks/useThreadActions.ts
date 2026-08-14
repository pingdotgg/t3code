import { parseScopedThreadKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { type ProjectId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { isThreadInSubtree } from "../sidebarThreadTree";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { useSettings } from "./useSettings";
import { refreshArchivedThreadsForEnvironment } from "../archivedThreadsState";

interface ArchivedThreadDeleteContext {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly worktreePath: string | null;
  };
  readonly project: {
    readonly id: ProjectId;
  };
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly worktreePath: string | null;
  }>;
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
  useLayoutEffect(() => {
    handleNewThreadRef.current = handleNewThread;
  }, [handleNewThread]);
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

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }
      const summary = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
      if (summary?.hasPendingQueuedTurn) {
        throw new Error("Cannot archive a thread with a queued continuation.");
      }

      const threadsBeforeArchive = selectThreadsForEnvironment(
        useStore.getState(),
        threadRef.environmentId,
      );

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const currentRouteIsInArchivedSubtree =
        currentRouteThreadRef?.environmentId === threadRef.environmentId &&
        isThreadInSubtree(threadsBeforeArchive, threadRef.threadId, currentRouteThreadRef.threadId);

      if (currentRouteIsInArchivedSubtree) {
        await handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId));
      }
    },
    [getCurrentRouteThreadRef, resolveThreadTarget],
  );

  const unarchiveThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
    refreshArchivedThreadsForEnvironment(target.environmentId);
  }, []);

  const settleThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      const resolved = resolveThreadTarget(target);
      if (!api || !resolved) return;
      const summary = selectSidebarThreadSummaryByRef(useStore.getState(), target);
      if (
        (resolved.thread.session?.status === "running" &&
          resolved.thread.session.activeTurnId != null) ||
        resolved.thread.latestTurn?.state === "running" ||
        summary?.hasPendingQueuedTurn
      ) {
        throw new Error("Cannot settle a thread with active work.");
      }
      await api.orchestration.dispatchCommand({
        type: "thread.settle",
        commandId: newCommandId(),
        threadId: target.threadId,
      });
    },
    [resolveThreadTarget],
  );

  const unsettleThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unsettle",
      commandId: newCommandId(),
      threadId: target.threadId,
      reason: "user",
    });
  }, []);

  const snoozeThread = useCallback(
    async (target: ScopedThreadRef, snoozedUntil: string) => {
      const api = readEnvironmentApi(target.environmentId);
      const resolved = resolveThreadTarget(target);
      if (!api || !resolved) return;
      if (resolved.thread.session?.status === "error") {
        throw new Error("Cannot snooze a thread that needs attention.");
      }
      await api.orchestration.dispatchCommand({
        type: "thread.snooze",
        commandId: newCommandId(),
        threadId: target.threadId,
        snoozedUntil,
      });
    },
    [resolveThreadTarget],
  );

  const unsnoozeThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unsnooze",
      commandId: newCommandId(),
      threadId: target.threadId,
      reason: "user",
    });
  }, []);

  const decoupleThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      if (resolved.thread.parentThreadId === null) {
        throw new Error("Only nested threads can be decoupled.");
      }
      await api.orchestration.dispatchCommand({
        type: "thread.decouple",
        commandId: newCommandId(),
        threadId: target.threadId,
      });
    },
    [resolveThreadTarget],
  );

  const deleteThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: {
        deletedThreadKeys?: ReadonlySet<string>;
        archivedContext?: ArchivedThreadDeleteContext;
      } = {},
    ) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      const thread = resolved?.thread ?? opts.archivedContext?.thread;
      const threadRef = target;
      const state = useStore.getState();
      const threads = selectThreadsForEnvironment(state, threadRef.environmentId);
      const threadProject =
        (thread
          ? selectProjectByRef(state, {
              environmentId: threadRef.environmentId,
              projectId: thread.projectId,
            })
          : undefined) ?? opts.archivedContext?.project;
      const threadsForWorktreeCheck = opts.archivedContext
        ? [
            ...threads,
            ...opts.archivedContext.threads.filter(
              (archivedThread) =>
                !threads.some((activeThread) => activeThread.id === archivedThread.id),
            ),
          ]
        : threads;
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
          ? threadsForWorktreeCheck.filter(
              (entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id),
            )
          : threadsForWorktreeCheck;
      const orphanedWorktreePath = thread
        ? getOrphanedWorktreePathForThread(survivingThreads, threadRef.threadId)
        : null;
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
            "Worktrees with uncommitted changes will be retained.",
          ].join("\n"),
        ));

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
        cleanupWorktree: shouldDeleteWorktree,
      });
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      clearComposerDraftForThread(threadRef);
      if (thread) {
        clearProjectDraftThreadById(
          scopeProjectRef(threadRef.environmentId, thread.projectId),
          threadRef,
        );
      }
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
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      getCurrentRouteThreadRef,
      router,
      resolveThreadTarget,
      sidebarThreadSortOrder,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (
      target: ScopedThreadRef,
      options?: {
        readonly archivedContext?: ArchivedThreadDeleteContext;
      },
    ) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const thread = resolved?.thread ?? options?.archivedContext?.thread;

      if (confirmThreadDelete && localApi) {
        const confirmed = await localApi.dialogs.confirm(
          [
            thread ? `Delete thread "${thread.title}"?` : "Delete this thread?",
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target, options);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return {
    archiveThread,
    unarchiveThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    decoupleThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
