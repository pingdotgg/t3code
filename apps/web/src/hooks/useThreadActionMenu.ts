import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { resolveSnoozePresets, snoozeWakeDescription } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
} from "../state/entities";
import { readLocalApi } from "../localApi";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, onStartRename } = input;
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const items = buildThreadActionMenuItems({
          branch: thread.branch ?? null,
          isPinned: thread.pinnedAt != null,
          isSettled: supports.settlement && thread.settledOverride === "settled",
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          isRunning: thread.session?.status === "running" && thread.session.activeTurnId != null,
          supports,
          snoozePresets,
        });
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => {
                  void unsnoozeThread(threadRef).then((undone) => {
                    if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                      failureToast("Failed to wake thread", squashAtomCommandFailure(undone));
                    }
                  });
                },
              },
            }),
          );
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Could not create thread", squashAtomCommandFailure(result));
            }
            return;
          }
          case "settle":
            await reportFailure("Failed to settle thread", () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure("Failed to un-settle thread", () => unsettleThread(threadRef));
            return;
          case "unsnooze":
            await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure("Failed to pin thread", () => pinThread(threadRef));
            return;
          case "unpin": {
            await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
            return;
          }
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(scopedThreadKey(threadRef), thread.latestTurn?.completedAt);
            return;
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              failureToast(
                didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
                squashAtomCommandFailure(result),
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmAndUnpinThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      markThreadUnread,
      onStartRename,
      pinThread,
      projectCwd,
      settleThread,
      snoozeThread,
      threadRef,
      timestampFormat,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
