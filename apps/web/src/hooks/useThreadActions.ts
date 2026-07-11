import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  getOwnedSubagentSubtree,
  threadSubtreeActionCopy,
} from "@t3tools/client-runtime/state/thread-relationships";
import { presentThreadShell, threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import {
  readArchivedThreadShells,
  refreshArchivedThreadsForEnvironment,
} from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentThreadRefs, readProject, readThreadShell } from "../state/entities";
import { environmentSnapshotAtom } from "../state/shell";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import { useAtomCommand } from "../state/use-atom-command";

function readEnvironmentThreads(environmentId: EnvironmentId) {
  const snapshot = appAtomRegistry.get(environmentSnapshotAtom(environmentId));
  if (snapshot !== null) {
    return [...snapshot.threads, ...snapshot.archivedThreads].map((thread) =>
      presentThreadShell(environmentId, thread),
    );
  }
  // The thread refs only track active threads, so merge in any archived
  // shells already loaded — otherwise subtree reads undercount descendants
  // whose parents are archived and skip recursive-action confirmations.
  const active = readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
    const thread = readThreadShell(ref);
    return thread === null ? [] : [thread];
  });
  const activeIds = new Set(active.map((thread) => thread.id));
  const archived = readArchivedThreadShells(environmentId)
    .filter((thread) => !activeIds.has(thread.id))
    .map((thread) => presentThreadShell(environmentId, thread));
  return [...active, ...archived];
}

/**
 * Client-side approximation of "archived together": the archive cascade
 * issues one command per subtree member, so `archivedAt` stamps differ by
 * command latency rather than matching exactly.
 */
const ARCHIVED_TOGETHER_TOLERANCE_MS = 60_000;

function wasArchivedWith(rootArchivedAt: string | null, archivedAt: string | null): boolean {
  if (rootArchivedAt === null || archivedAt === null) return false;
  return (
    Math.abs(Date.parse(archivedAt) - Date.parse(rootArchivedAt)) <= ARCHIVED_TOGETHER_TOLERANCE_MS
  );
}

/** Reads the complete active + archived owned-subagent subtree from the shell cache. */
export function readThreadSubtree(
  target: ScopedThreadRef,
  fallbackRoot?: ReturnType<typeof presentThreadShell>,
) {
  const threads = readEnvironmentThreads(target.environmentId);
  const root = threads.find((candidate) => candidate.id === target.threadId) ?? fallbackRoot;
  if (root === undefined) return [];
  return getOwnedSubagentSubtree(
    threads.some((candidate) => candidate.id === root.id) ? threads : [...threads, root],
    root,
  );
}

export function useThreadActions() {
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const archiveThreadMutation = useAtomCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useAtomCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useAtomCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const thread =
      readThreadShell(target) ??
      readEnvironmentThreads(target.environmentId).find(
        (candidate) => candidate.id === target.threadId,
      );
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getThreadSubtree = useCallback(
    (target: ScopedThreadRef, fallbackRoot?: ReturnType<typeof presentThreadShell>) =>
      readThreadSubtree(target, fallbackRoot),
    [],
  );
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const resolved = resolveThreadTarget(target);
      if (!resolved) return AsyncResult.success(undefined);
      const { thread, threadRef } = resolved;

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const subtree = getThreadSubtree(threadRef, thread);
      const shouldNavigateToDraft =
        currentRouteThreadRef?.environmentId === threadRef.environmentId &&
        subtree.some((entry) => entry.id === currentRouteThreadRef.threadId);
      const archiveResult = await archiveThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (archiveResult._tag === "Failure") {
        return archiveResult;
      }
      // Archiving a root archives the subagent threads it recursively owns.
      // Each member gets its own command; attempt the full subtree before
      // reporting the first failure so one refusal cannot strand the rest.
      let descendantFailure: Awaited<ReturnType<typeof archiveThreadMutation>> | null = null;
      for (const entry of subtree.slice(1).filter((entry) => entry.archivedAt === null)) {
        const result = await archiveThreadMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: entry.id },
        });
        if (result._tag === "Failure") {
          descendantFailure ??= result;
        }
      }
      if (descendantFailure !== null) {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return descendantFailure;
      }

      if (shouldNavigateToDraft) {
        const navigationResult = await settlePromise(() =>
          handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId)),
        );
        if (navigationResult._tag === "Failure") {
          return navigationResult;
        }
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return archiveResult;
      }

      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      return archiveResult;
    },
    [archiveThreadMutation, getCurrentRouteThreadRef, getThreadSubtree, resolveThreadTarget],
  );

  const confirmAndArchiveThread = useCallback(
    async (target: ScopedThreadRef, options: { readonly confirmed?: boolean } = {}) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const subtree = getThreadSubtree(target, resolved?.thread);
      const descendants = subtree.slice(1).filter((entry) => entry.archivedAt === null);
      const activeThreadCount = [resolved?.thread, ...descendants].filter(
        (entry) => entry !== undefined && threadRuntimeIsActive(entry.runtime),
      ).length;
      if (
        options.confirmed !== true &&
        (confirmThreadArchive || descendants.length > 0 || activeThreadCount > 0) &&
        localApi
      ) {
        const copy = threadSubtreeActionCopy({
          action: "archive",
          threadTitle: resolved?.thread.title ?? "this thread",
          descendantCount: descendants.length,
          activeThreadCount,
        });
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm([copy.title, copy.message].join("\n")),
        );
        if (confirmationResult._tag === "Failure") return confirmationResult;
        if (!confirmationResult.value) return AsyncResult.success(undefined);
      }
      return archiveThread(target);
    },
    [archiveThread, confirmThreadArchive, getThreadSubtree, resolveThreadTarget],
  );

  const unarchiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const resolved = resolveThreadTarget(target);
      const subtree = resolved === null ? [] : readThreadSubtree(target, resolved.thread);
      const rootArchivedAt = resolved?.thread.archivedAt ?? null;
      const result = await unarchiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Failure") {
        return result;
      }
      // Restore the owned subagent threads that were archived together with
      // the root, mirroring the cascade in archiveThread.
      let descendantFailure: Awaited<ReturnType<typeof unarchiveThreadMutation>> | null = null;
      for (const entry of subtree
        .slice(1)
        .filter((entry) => wasArchivedWith(rootArchivedAt, entry.archivedAt))) {
        const descendantResult = await unarchiveThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: entry.id },
        });
        if (descendantResult._tag === "Failure") {
          descendantFailure ??= descendantResult;
        }
      }
      refreshArchivedThreadsForEnvironment(target.environmentId);
      return descendantFailure ?? result;
    },
    [resolveThreadTarget, unarchiveThreadMutation],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, opts: { deletedThreadKeys?: ReadonlySet<string> } = {}) => {
      const resolved = resolveThreadTarget(target);
      if (!resolved) {
        // Thread not in main store (e.g. archived thread) — dispatch delete directly.
        const result = await deleteThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (result._tag === "Success") {
          refreshArchivedThreadsForEnvironment(target.environmentId);
        }
        return result;
      }
      const { thread, threadRef } = resolved;
      const threads = readEnvironmentThreads(threadRef.environmentId);
      const subtree = getOwnedSubagentSubtree(threads, thread);
      const threadProject = readProject({
        environmentId: threadRef.environmentId,
        projectId: thread.projectId,
      });
      const explicitlyDeletedIds = new Set<ThreadId>(
        [...(opts.deletedThreadKeys ?? [])].flatMap((threadKey) => {
          const ref = parseScopedThreadKey(threadKey);
          return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
        }),
      );
      explicitlyDeletedIds.add(threadRef.threadId);
      const deletedIds = new Set<ThreadId>();
      for (const rootId of explicitlyDeletedIds) {
        const root = threads.find((entry) => entry.id === rootId);
        if (root === undefined) {
          deletedIds.add(rootId);
          continue;
        }
        for (const entry of getOwnedSubagentSubtree(threads, root)) {
          deletedIds.add(entry.id);
        }
      }
      const survivingThreads =
        deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        survivingThreads,
        threadRef.threadId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== null;
      const localApi = readLocalApi();
      let shouldDeleteWorktree = false;
      if (canDeleteWorktree && localApi) {
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              "This thread is the only one linked to this worktree:",
              displayWorktreePath ?? orphanedWorktreePath,
              "",
              "Delete the worktree too?",
            ].join("\n"),
          ),
        );
        if (confirmationResult._tag === "Failure") {
          return confirmationResult;
        }
        shouldDeleteWorktree = confirmationResult.value;
      }

      // The whole owned subtree is deleted, so stop every member's session
      // and terminal — not just the selected root's.
      for (const entry of subtree) {
        if (entry.runtime !== null) {
          await stopThreadSession({
            environmentId: threadRef.environmentId,
            input: { threadId: entry.id },
          });
        }
      }
      for (const entry of subtree) {
        await closeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId: entry.id, deleteHistory: true },
        });
      }

      const deletedThreadIds = deletedIds;
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.environmentId === threadRef.environmentId &&
        deletedThreadIds.has(currentRouteThreadRef.threadId);
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads: threads.filter((entry) => entry.archivedAt === null),
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      const deleteResult = await deleteThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (deleteResult._tag === "Failure") {
        return deleteResult;
      }
      // Deleting a root deletes the subagent threads it recursively owns.
      // Attempt every member before reporting the first failure; survivors
      // stay visible as recovery roots rather than silently lingering.
      let descendantDeleteFailure: Awaited<ReturnType<typeof deleteThreadMutation>> | null = null;
      for (const entry of subtree.slice(1)) {
        const result = await deleteThreadMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: entry.id },
        });
        if (result._tag === "Failure") {
          descendantDeleteFailure ??= result;
        }
      }
      if (descendantDeleteFailure !== null) {
        refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return descendantDeleteFailure;
      }
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      for (const deletedThread of subtree) {
        const deletedThreadRef = scopeThreadRef(deletedThread.environmentId, deletedThread.id);
        clearComposerDraftForThread(deletedThreadRef);
        clearProjectDraftThreadById(
          scopeProjectRef(deletedThread.environmentId, deletedThread.projectId),
          deletedThreadRef,
        );
        clearTerminalUiState(deletedThreadRef);
      }

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          const fallbackThread = readThreadShell(
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            const navigationResult = await settlePromise(() =>
              router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
                ),
                replace: true,
              }),
            );
            if (navigationResult._tag === "Failure") {
              return navigationResult;
            }
          } else {
            const navigationResult = await settlePromise(() =>
              router.navigate({ to: "/", replace: true }),
            );
            if (navigationResult._tag === "Failure") {
              return navigationResult;
            }
          }
        } else {
          const navigationResult = await settlePromise(() =>
            router.navigate({ to: "/", replace: true }),
          );
          if (navigationResult._tag === "Failure") {
            return navigationResult;
          }
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return deleteResult;
      }

      const removeResult = await removeWorktree({
        environmentId: threadRef.environmentId,
        input: {
          cwd: threadProject.workspaceRoot,
          path: orphanedWorktreePath,
          force: true,
        },
      });
      const refreshResult =
        removeResult._tag === "Success"
          ? await refreshVcsStatus({
              environmentId: threadRef.environmentId,
              input: { cwd: threadProject.workspaceRoot },
            })
          : null;
      const cleanupFailure =
        removeResult._tag === "Failure"
          ? removeResult
          : refreshResult?._tag === "Failure"
            ? refreshResult
            : null;
      if (cleanupFailure) {
        const error = squashAtomCommandFailure(cleanupFailure);
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId: threadRef.threadId,
          projectCwd: threadProject.workspaceRoot,
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
        return cleanupFailure;
      }
      return deleteResult;
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalUiState,
      closeTerminal,
      deleteThreadMutation,
      getCurrentRouteThreadRef,
      refreshVcsStatus,
      removeWorktree,
      router,
      resolveThreadTarget,
      sidebarThreadSortOrder,
      stopThreadSession,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const subtree = getThreadSubtree(target, resolved?.thread);
      const descendantCount = Math.max(0, subtree.length - 1);
      const activeThreadCount = subtree.filter((entry) =>
        threadRuntimeIsActive(entry.runtime),
      ).length;

      if ((confirmThreadDelete || descendantCount > 0 || activeThreadCount > 0) && localApi) {
        const copy = threadSubtreeActionCopy({
          action: "delete",
          threadTitle: resolved?.thread.title ?? "this thread",
          descendantCount,
          activeThreadCount,
        });
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm([copy.title, copy.message].join("\n")),
        );
        if (confirmationResult._tag === "Failure") {
          return confirmationResult;
        }
        if (!confirmationResult.value) {
          return AsyncResult.success(undefined);
        }
      }

      return deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, getThreadSubtree, resolveThreadTarget],
  );

  const confirmAndUnarchiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const subtree = getThreadSubtree(target, resolved?.thread);
      const descendantCount =
        resolved === null
          ? 0
          : subtree
              .slice(1)
              .filter((entry) => wasArchivedWith(resolved.thread.archivedAt, entry.archivedAt))
              .length;
      if (descendantCount > 0 && localApi) {
        const copy = threadSubtreeActionCopy({
          action: "unarchive",
          threadTitle: resolved?.thread.title ?? "this thread",
          descendantCount,
        });
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm([copy.title, copy.message].join("\n")),
        );
        if (confirmationResult._tag === "Failure") return confirmationResult;
        if (!confirmationResult.value) return AsyncResult.success(undefined);
      }
      return unarchiveThread(target);
    },
    [getThreadSubtree, resolveThreadTarget, unarchiveThread],
  );

  return useMemo(
    () => ({
      archiveThread,
      confirmAndArchiveThread,
      unarchiveThread,
      confirmAndUnarchiveThread,
      deleteThread,
      confirmAndDeleteThread,
      getThreadSubtree,
    }),
    [
      archiveThread,
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      confirmAndUnarchiveThread,
      deleteThread,
      getThreadSubtree,
      unarchiveThread,
    ],
  );
}
