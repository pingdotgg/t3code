import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import type { useThreadActions } from "./useThreadActions";
import { readLocalApi } from "../localApi";
import { readThreadShell } from "../state/entities";
import {
  archiveSelectedThreadEntries,
  canArchiveSettledSidebarThread,
  formatArchiveSkippedDescription,
  getCompletedArchiveThreadKeys,
  isThreadArchiveBlocked,
  withCoordinatedThreadArchiveEntries,
} from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export type SidebarArchiveEntry = {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
};

type SidebarArchiveActionsInput = {
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  readonly archivableSettledThreads: readonly EnvironmentThreadShell[];
  readonly confirmThreadArchive: boolean;
  readonly removeFromSelection: (threadKeys: readonly string[]) => void;
  readonly settledThreadKeysRef: { readonly current: ReadonlySet<string> };
  readonly threadByKeyRef: {
    readonly current: ReadonlyMap<string, EnvironmentThreadShell>;
  };
};

type CoordinatedArchiveOptions = {
  readonly confirmationMessage: (entries: readonly SidebarArchiveEntry[]) => string;
  readonly recheckLiveEligibility?: boolean;
  readonly requireStillSettled?: boolean;
};

/**
 * Owns the default sidebar's fork-specific archive flows. Keeping the
 * coordination and confirmation lifecycle out of the upstream-owned sidebar
 * component limits future default-sidebar reconciliations to its integration
 * points.
 */
export function useSidebarArchiveActions({
  archiveThread,
  archivableSettledThreads,
  confirmThreadArchive,
  removeFromSelection,
  settledThreadKeysRef,
  threadByKeyRef,
}: SidebarArchiveActionsInput) {
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
      entries: readonly SidebarArchiveEntry[],
      options: {
        readonly onCompleted?: (threadKey: string) => void;
        readonly recheckLiveEligibility?: boolean;
        readonly requireStillSettled?: boolean;
      } = {},
    ) => {
      const outcome = await archiveSelectedThreadEntries({
        entries,
        archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        ...(options.recheckLiveEligibility
          ? {
              canArchive: ({ threadKey, threadRef }: SidebarArchiveEntry) => {
                const thread = readThreadShell(threadRef);
                if (!options.requireStillSettled) {
                  return !isThreadArchiveBlocked(thread);
                }
                return canArchiveSettledSidebarThread({
                  threadKey,
                  settledThreadKeys: settledThreadKeysRef.current,
                  session: thread?.session,
                  backgroundLiveness: thread?.backgroundLiveness,
                });
              },
            }
          : {}),
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
    [archiveThread, settledThreadKeysRef],
  );

  // One archive per thread at a time across row, selection, and settled
  // partition flows. Later flows wait for owners, then retry only entries that
  // were neither archived nor intentionally skipped by the earlier flow.
  const archivingThreadReservationsRef = useRef(new Map<string, Promise<ReadonlySet<string>>>());
  const archiveCoordinatedEntries = useCallback(
    async (entries: readonly SidebarArchiveEntry[], options: CoordinatedArchiveOptions) => {
      await withCoordinatedThreadArchiveEntries({
        entries,
        reservations: archivingThreadReservationsRef.current,
        run: async (ownedEntries, onCompleted) => {
          if (!(await confirmArchive(options.confirmationMessage(ownedEntries)))) return [];
          const outcome = await archiveThreadEntries(ownedEntries, {
            onCompleted,
            ...(options.recheckLiveEligibility === undefined
              ? {}
              : { recheckLiveEligibility: options.recheckLiveEligibility }),
            ...(options.requireStillSettled === undefined
              ? {}
              : { requireStillSettled: options.requireStillSettled }),
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
      void archiveCoordinatedEntries([{ threadKey: scopedThreadKey(threadRef), threadRef }], {
        confirmationMessage: ([entry]) => {
          const thread = entry ? threadByKeyRef.current.get(entry.threadKey) : undefined;
          return thread ? `Archive thread "${thread.title}"?` : "Archive this thread?";
        },
      });
    },
    [archiveCoordinatedEntries, threadByKeyRef],
  );

  const archiveSelectedEntries = useCallback(
    (entries: readonly SidebarArchiveEntry[]) =>
      archiveCoordinatedEntries(entries, {
        confirmationMessage: (ownedEntries) => {
          const count = ownedEntries.length;
          return `Archive ${count} thread${count === 1 ? "" : "s"}?`;
        },
        recheckLiveEligibility: true,
      }),
    [archiveCoordinatedEntries],
  );

  const [isArchivingAllSettled, setIsArchivingAllSettled] = useState(false);
  const archivingAllSettledRef = useRef(false);
  const archiveAllSettled = useCallback(() => {
    void (async () => {
      if (archivingAllSettledRef.current || archivableSettledThreads.length === 0) return;
      archivingAllSettledRef.current = true;
      setIsArchivingAllSettled(true);
      try {
        await archiveCoordinatedEntries(
          archivableSettledThreads.map((thread) => {
            const threadRef = scopeThreadRef(thread.environmentId, thread.id);
            return { threadKey: scopedThreadKey(threadRef), threadRef };
          }),
          {
            confirmationMessage: (ownedEntries) => {
              const count = ownedEntries.length;
              return `Archive all ${count} settled thread${count === 1 ? "" : "s"}?`;
            },
            recheckLiveEligibility: true,
            requireStillSettled: true,
          },
        );
      } finally {
        archivingAllSettledRef.current = false;
        setIsArchivingAllSettled(false);
      }
    })();
  }, [archivableSettledThreads, archiveCoordinatedEntries]);

  return {
    archiveAllSettled,
    archiveSelectedEntries,
    attemptArchive,
    isArchivingAllSettled,
  };
}
