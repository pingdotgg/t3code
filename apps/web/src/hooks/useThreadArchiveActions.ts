import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  archiveSelectedThreadEntries,
  formatArchiveSkippedDescription,
  getCompletedArchiveThreadKeys,
  withCoordinatedThreadArchiveEntries,
} from "../components/SidebarArchiveControls.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { readThreadShell } from "../state/entities";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { useThreadActions } from "./useThreadActions";

export type ThreadArchiveEntry = {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
};

export type CoordinatedArchiveOptions = {
  readonly confirmationMessage: (entries: readonly ThreadArchiveEntry[]) => string;
  readonly canArchive?: (entry: ThreadArchiveEntry) => boolean;
};

type ThreadArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly confirmThreadArchive: boolean;
};

/**
 * Shared archive policy for every web surface. The reservation pool lives in
 * the pure coordination module, so separate hook instances (for example the
 * sidebar and chat header) cannot race the same thread.
 */
export function useThreadArchiveActions({
  archiveThread,
  confirmThreadArchive,
}: ThreadArchiveActionsInput) {
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);

  const confirmArchive = useCallback(
    async (message: string) => {
      if (!confirmThreadArchive) return true;
      const api = readLocalApi();
      if (!api) return false;
      const result = await settlePromise(() => api.dialogs.confirm(message));
      return result._tag === "Success" && result.value;
    },
    [confirmThreadArchive],
  );

  const archiveThreadEntries = useCallback(
    async (
      entries: readonly ThreadArchiveEntry[],
      options: {
        readonly canArchive?: (entry: ThreadArchiveEntry) => boolean;
        readonly onCompleted?: (threadKey: string) => void;
      } = {},
    ) => {
      const outcome = await archiveSelectedThreadEntries({
        entries,
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        ...(options.canArchive ? { canArchive: options.canArchive } : {}),
        onArchived: ({ threadKey }) => options.onCompleted?.(threadKey),
        onSkipped: ({ threadKey }) => options.onCompleted?.(threadKey),
      });
      for (const failure of outcome.followupFailures) {
        if (isAtomCommandInterrupted(failure)) continue;
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread archived, but navigation failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      if (outcome.mutationFailure && !isAtomCommandInterrupted(outcome.mutationFailure)) {
        const error = squashAtomCommandFailure(outcome.mutationFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: entries.length === 1 ? "Failed to archive thread" : "Failed to archive threads",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      if (outcome.skippedThreadKeys.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title:
              outcome.archivedThreadKeys.length === 0
                ? "No threads archived"
                : "Some threads were not archived",
            description: formatArchiveSkippedDescription(outcome.skippedThreadKeys.length),
          }),
        );
      }
      return outcome;
    },
    [archiveThread],
  );

  const archiveCoordinatedEntries = useCallback(
    async (entries: readonly ThreadArchiveEntry[], options: CoordinatedArchiveOptions) => {
      await withCoordinatedThreadArchiveEntries({
        entries,
        run: async (ownedEntries, onCompleted) => {
          if (!(await confirmArchive(options.confirmationMessage(ownedEntries)))) return [];
          const outcome = await archiveThreadEntries(ownedEntries, {
            onCompleted,
            ...(options.canArchive ? { canArchive: options.canArchive } : {}),
          });
          removeFromSelection(outcome.archivedThreadKeys);
          return getCompletedArchiveThreadKeys(outcome);
        },
      });
    },
    [archiveThreadEntries, confirmArchive, removeFromSelection],
  );

  const attemptArchive = useCallback(
    (threadRef: ScopedThreadRef) => {
      void archiveCoordinatedEntries(
        [{ threadKey: scopedThreadKey(threadRef), threadRef }],
        {
          confirmationMessage: ([entry]) => {
            const thread = entry ? readThreadShell(entry.threadRef) : null;
            return thread ? `Archive thread "${thread.title}"?` : "Archive this thread?";
          },
        },
      );
    },
    [archiveCoordinatedEntries],
  );

  return { archiveCoordinatedEntries, attemptArchive };
}
