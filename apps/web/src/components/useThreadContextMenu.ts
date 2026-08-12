import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { boardLaneForPlacementAction } from "../board/boardPlacementMenu.ts";
import type { BoardLane } from "../board/boardLaneStore.ts";
import { useBoardLaneStore } from "../board/boardLaneStore.ts";
import { useNewThreadHandler } from "../hooks/useHandleNewThread.ts";
import { useThreadActions } from "../hooks/useThreadActions.ts";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.ts";
import { useClientSettings } from "../hooks/useSettings.ts";
import { readLocalApi } from "../localApi.ts";
import type { SidebarThreadSummary } from "../types.ts";
import { stackedThreadToast, toastManager } from "./ui/toast.tsx";
import {
  buildThreadContextMenuItems,
  THREAD_CONTEXT_MENU_ITEM_IDS,
} from "./threadContextMenu.logic.ts";

export type ThreadContextMenuTarget = {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly workspacePath: string | null;
  readonly lanes: ReadonlyArray<BoardLane>;
};

export type UseThreadContextMenuOptions = {
  readonly onRename?: (threadKey: string, title: string) => void;
  readonly onMarkUnread?: (
    threadKey: string,
    latestTurnCompletedAt: string | null | undefined,
  ) => void;
};

export function useThreadContextMenu(options: UseThreadContextMenuOptions = {}) {
  const { onRename, onMarkUnread } = options;
  const { deleteThread } = useThreadActions();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const handleNewThread = useNewThreadHandler();
  const setPlacement = useBoardLaneStore((state) => state.setPlacement);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const dispatchThreadContextMenuAction = useCallback(
    async (clicked: string | null, target: ThreadContextMenuTarget) => {
      const { threadRef, thread, workspacePath, lanes } = target;

      const laneId = boardLaneForPlacementAction(clicked, lanes);
      if (laneId !== undefined) {
        setPlacement(threadRef, laneId);
        return;
      }

      if (clicked === THREAD_CONTEXT_MENU_ITEM_IDS.newThreadOnBranch) {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            envMode: thread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const threadKey = scopedThreadKey(threadRef);

      if (clicked === THREAD_CONTEXT_MENU_ITEM_IDS.rename) {
        onRename?.(threadKey, thread.title);
        return;
      }

      if (clicked === THREAD_CONTEXT_MENU_ITEM_IDS.markUnread) {
        onMarkUnread?.(threadKey, thread.latestTurn?.completedAt);
        return;
      }

      if (clicked === THREAD_CONTEXT_MENU_ITEM_IDS.copyPath) {
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

      if (clicked === THREAD_CONTEXT_MENU_ITEM_IDS.copyThreadId) {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }

      if (clicked !== THREAD_CONTEXT_MENU_ITEM_IDS.delete) return;

      const api = readLocalApi();
      if (confirmThreadDelete && api) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      const result = await deleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      onMarkUnread,
      onRename,
      setPlacement,
    ],
  );

  const openThreadContextMenu = useCallback(
    async (target: ThreadContextMenuTarget, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;

      const items = buildThreadContextMenuItems({
        thread: target.thread,
        lanes: target.lanes,
        includeRename: onRename !== undefined,
        includeMarkUnread: onMarkUnread !== undefined,
      });

      const clicked = await api.contextMenu.show(items, position);
      await dispatchThreadContextMenuAction(clicked, target);
    },
    [dispatchThreadContextMenuAction, onMarkUnread, onRename],
  );

  return { openThreadContextMenu, dispatchThreadContextMenuAction };
}
