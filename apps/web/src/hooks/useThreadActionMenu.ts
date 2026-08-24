import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestSettleSource,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useI18n, type Translate } from "../i18n";
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
import { localizedClipboardErrorMessage, useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { localizedThreadActionError, useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown, t: Translate) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: localizedThreadActionError(error, t),
    }),
  );
}

function clipboardFailureToast(title: string, error: unknown, t: Translate) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: localizedClipboardErrorMessage(error, t),
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
  /** PR feeding auto-settle classification, as resolved by the caller. */
  readonly changeRequest: ChangeRequestSettleSource | null;
  readonly onStartRename: () => void;
}) {
  const { t } = useI18n();
  const { threadRef, projectCwd, changeRequest, onStartRename } = input;
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((s) => s.sidebarAutoSettleOnMerge);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: t("sidebar.pathCopied"), description: path });
    },
    onError: (error) => clipboardFailureToast(t("sidebar.copyPathFailed"), error, t),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: t("sidebar.branchCopied"), description: branch });
    },
    onError: (error) => clipboardFailureToast(t("sidebar.copyBranchFailed"), error, t),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: t("sidebar.threadIdCopied"),
        description: threadId,
      });
    },
    onError: (error) => clipboardFailureToast(t("sidebar.copyThreadIdFailed"), error, t),
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
        const snoozePresets = resolveSnoozePresets(now, timestampFormat, t);
        const items = buildThreadActionMenuItems(
          {
            branch: thread.branch ?? null,
            isPinned: thread.pinnedAt != null,
            isSettled:
              supports.settlement &&
              effectiveSettled(thread, {
                // Minute-quantized like useNowMinute, so this classification
                // can never disagree with the sidebar partition or ChatView's
                // parked-thread banner within the same minute.
                now: `${now.toISOString().slice(0, 16)}:00.000Z`,
                autoSettleAfterDays,
                autoSettleOnMerge,
                changeRequest,
              }),
            isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
            canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
            isRegeneratingTitle,
            isRunning: thread.session?.status === "running" && thread.session.activeTurnId != null,
            supports,
            snoozePresets,
          },
          t,
        );
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        if (action.startsWith("snooze:")) {
          const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              failureToast(t("sidebar.snoozeThreadFailed"), squashAtomCommandFailure(result), t);
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: t("sidebar.snoozedUntil", {
                time: snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat, t),
              }),
              timeout: 5_000,
              actionProps: {
                children: t("sidebar.undo"),
                onClick: () => {
                  void unsnoozeThread(threadRef).then((undone) => {
                    if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                      failureToast(
                        t("sidebar.wakeThreadFailed"),
                        squashAtomCommandFailure(undone),
                        t,
                      );
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
            failureToast(title, squashAtomCommandFailure(result), t);
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
              failureToast(t("sidebar.createThreadFailed"), squashAtomCommandFailure(result), t);
            }
            return;
          }
          case "settle":
            await reportFailure(t("sidebar.settleThreadFailed"), () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure(t("sidebar.unsettleThreadFailed"), () => unsettleThread(threadRef));
            return;
          case "unsnooze":
            await reportFailure(t("sidebar.wakeThreadFailed"), () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure(t("sidebar.pinThreadFailed"), () => pinThread(threadRef));
            return;
          case "unpin":
            await reportFailure(t("sidebar.unpinThreadFailed"), () => unpinThread(threadRef));
            return;
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure(t("sidebar.regenerateTitleFailed"), () =>
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
                  title: t("sidebar.pathUnavailable"),
                  description: t("sidebar.threadPathUnavailable"),
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
                api.dialogs.confirm(t("sidebar.archiveThreadConfirm", { title: thread.title })),
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
                didArchive
                  ? t("sidebar.archivedNavigationFailed")
                  : t("sidebar.archiveThreadFailed"),
                squashAtomCommandFailure(result),
                t,
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    t("sidebar.deleteThreadConfirm", { title: thread.title }),
                    t("sidebar.clearHistorySingle"),
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
              failureToast(t("sidebar.deleteThreadFailed"), squashAtomCommandFailure(deleted), t);
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
      autoSettleAfterDays,
      autoSettleOnMerge,
      changeRequest,
      confirmThreadArchive,
      confirmThreadDelete,
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
      t,
      unpinThread,
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
