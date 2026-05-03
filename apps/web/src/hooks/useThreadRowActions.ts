import { scopedThreadKey } from "@forma/client-runtime";
import type { ScopedThreadRef, ThreadId } from "@forma/contracts";
import { useCallback } from "react";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useThreadActions } from "./useThreadActions";

interface MarkUnreadInput {
  threadRef: ScopedThreadRef;
  latestTurnCompletedAt: string | null | undefined;
}

export function useThreadRowActions() {
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const { archiveThread, confirmAndDeleteThread, forkThread } = useThreadActions();
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
  const { copyToClipboard: copyThreadMarkdownToClipboard } = useCopyToClipboard<{
    markdown: string;
  }>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Thread markdown copied",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread markdown",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const markUnread = useCallback(
    ({ threadRef, latestTurnCompletedAt }: MarkUnreadInput) => {
      markThreadUnread(scopedThreadKey(threadRef), latestTurnCompletedAt);
    },
    [markThreadUnread],
  );

  const copyWorkspacePath = useCallback(
    (path: string | null) => {
      if (!path) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          }),
        );
        return;
      }

      copyPathToClipboard(path, { path });
    },
    [copyPathToClipboard],
  );

  const copyThreadId = useCallback(
    (threadId: ThreadId) => {
      copyThreadIdToClipboard(threadId, { threadId });
    },
    [copyThreadIdToClipboard],
  );

  const copyThreadAsMarkdown = useCallback(
    (markdown: string) => {
      copyThreadMarkdownToClipboard(markdown, { markdown });
    },
    [copyThreadMarkdownToClipboard],
  );

  const archiveNow = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const forkNow = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await forkThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to fork thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [forkThread],
  );

  const deleteWithConfirmation = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await confirmAndDeleteThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [confirmAndDeleteThread],
  );

  return {
    markUnread,
    copyThreadAsMarkdown,
    copyWorkspacePath,
    copyThreadId,
    archiveNow,
    forkNow,
    deleteWithConfirmation,
  };
}
