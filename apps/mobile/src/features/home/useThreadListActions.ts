import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { claimThreadsForBatch, releaseThreadKeys } from "../../lib/inFlightThreadKeys";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { HomeThreadGroup } from "./homeThreadList";

type ThreadListAction = "archive" | "unarchive" | "settle" | "unsettle" | "delete";

const ACTION_PAST_TENSE: Record<ThreadListAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  settle: "settled",
  unsettle: "marked as active",
  delete: "deleted",
};

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `The thread could not be ${ACTION_PAST_TENSE[action]}.`;
}

function selectionHaptic(): void {
  if (process.env.EXPO_OS === "ios") {
    void Haptics.selectionAsync();
  }
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "unarchive") return "Could not unarchive thread";
  if (action === "settle") return "Could not settle thread";
  if (action === "unsettle") return "Could not mark thread as active";
  return "Could not delete thread";
}

/**
 * Thread keys with a mutation in flight, shared by the single-thread actions
 * and the group archive so neither can submit a second command for a thread
 * the other is already acting on. `thread.archive` is not idempotent — the
 * decider rejects it via `requireThreadNotArchived` — and the command
 * scheduler serializes per thread, so an unguarded overlap does not race, it
 * deterministically fails the second submission.
 */
type InFlightThreadKeys = { readonly current: Set<string> };

function useInFlightThreadKeys(): InFlightThreadKeys {
  return useRef(new Set<string>());
}

function useThreadActionExecutor(
  inFlightThreadKeys: InFlightThreadKeys,
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        const result =
          action === "settle"
            ? await settleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              })
            : action === "unsettle"
              ? await unsettleMutation({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id, reason: "user" },
                })
              : await (
                  action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
                )({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id },
                });
        if (result._tag === "Failure") {
          Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
          return;
        }
        onCompleted?.(action, thread);
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [
      archiveMutation,
      deleteMutation,
      inFlightThreadKeys,
      onCompleted,
      settleMutation,
      unarchiveMutation,
      unsettleMutation,
    ],
  );

  return executeAction;
}

function useConfirmDeleteThread(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<void>,
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      Alert.alert(
        "Delete thread?",
        `“${thread.title}” will be permanently deleted, including its terminal history.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void executeAction("delete", thread);
            },
          },
        ],
      );
    },
    [executeAction],
  );
}

/**
 * Batch archive, used by the settled disclosure's archive-all action (mac
 * `AppModel.archiveThreads` parity). Individual failures do not stop the run,
 * and the outcome is reported once instead of one alert per thread. A group
 * can span environments, so each thread carries its own environment id.
 */
function useConfirmArchiveThreads(inFlightThreadKeys: InFlightThreadKeys) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });

  const archiveThreads = useCallback(
    async (threads: ReadonlyArray<EnvironmentThreadShell>) => {
      const claimed = claimThreadsForBatch(threads, inFlightThreadKeys.current);
      if (claimed.length === 0) {
        return;
      }

      selectionHaptic();
      try {
        let failures = 0;
        let firstFailure: string | null = null;
        for (const { thread } of claimed) {
          const result = await archiveMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          });
          if (result._tag === "Failure") {
            failures += 1;
            firstFailure ??= actionFailureMessage("archive", result.cause);
          }
        }
        if (firstFailure !== null) {
          Alert.alert(
            actionFailureTitle("archive"),
            failures === claimed.length
              ? firstFailure
              : `Failed to archive ${failures} of ${claimed.length} threads: ${firstFailure}`,
          );
        }
      } finally {
        releaseThreadKeys(claimed, inFlightThreadKeys.current);
      }
    },
    [archiveMutation, inFlightThreadKeys],
  );

  return useCallback(
    (threads: ReadonlyArray<EnvironmentThreadShell>) => {
      if (threads.length === 0) {
        return;
      }
      Alert.alert(
        `Archive ${threads.length} settled thread${threads.length === 1 ? "" : "s"}?`,
        "They move to Archive and can be unarchived from there.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Archive",
            onPress: () => {
              void archiveThreads(threads);
            },
          },
        ],
      );
    },
    [archiveThreads],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => void;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmArchiveThreads: (threads: ReadonlyArray<EnvironmentThreadShell>) => void;
} {
  // One in-flight set for both paths: the group archive and the swipe/context
  // actions must not both submit for the same thread.
  const inFlightThreadKeys = useInFlightThreadKeys();
  const executeAction = useThreadActionExecutor(inFlightThreadKeys);

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );

  const settleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("settle", thread);
    },
    [executeAction],
  );

  const unsettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unsettle", thread);
    },
    [executeAction],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);
  const confirmArchiveThreads = useConfirmArchiveThreads(inFlightThreadKeys);

  return {
    archiveThread,
    settleThread,
    unsettleThread,
    confirmDeleteThread,
    confirmArchiveThreads,
  };
}

/**
 * Turns the settled disclosure's group key into the archive-all batch, read
 * from the groups at press time.
 *
 * `buildHomeThreadGroups` rebuilds `settledThreads` on every thread event, so
 * the batch cannot ride along in the list item without churning the row's
 * identity on unrelated updates. Reading it through a ref also keeps the
 * returned callback referentially stable, so the memoized row does not
 * re-render just because the groups were recomputed — and the archive always
 * acts on the current settled set rather than whatever the row last rendered.
 */
export function useArchiveSettledGroup(
  groups: ReadonlyArray<HomeThreadGroup>,
  confirmArchiveThreads: (threads: ReadonlyArray<EnvironmentThreadShell>) => void,
): (groupKey: string) => void {
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const confirmRef = useRef(confirmArchiveThreads);
  confirmRef.current = confirmArchiveThreads;

  return useCallback((groupKey: string) => {
    const group = groupsRef.current.find((candidate) => candidate.key === groupKey);
    if (!group || group.settledThreads.length === 0) {
      return;
    }
    confirmRef.current(group.settledThreads);
  }, []);
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
      onCompleted(thread);
    },
    [onCompleted],
  );
  // The archive list has no group archive to coordinate with, so it keeps its
  // own set rather than sharing the thread list's.
  const executeAction = useThreadActionExecutor(useInFlightThreadKeys(), handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
