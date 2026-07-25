import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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

function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

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

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => void;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const executeAction = useThreadActionExecutor();

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

  return { archiveThread, settleThread, unsettleThread, confirmDeleteThread };
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
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
