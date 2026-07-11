import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { presentThreadShell, threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  getOwnedSubagentSubtree,
  threadSubtreeActionCopy,
} from "@t3tools/client-runtime/state/thread-relationships";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type ThreadListAction = "archive" | "unarchive" | "delete";

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const verb =
    action === "archive" ? "archived" : action === "unarchive" ? "unarchived" : "deleted";
  return `The thread could not be ${verb}.`;
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "unarchive") return "Could not unarchive thread";
  return "Could not delete thread";
}

function readThreadSubtree(thread: EnvironmentThreadShell): readonly EnvironmentThreadShell[] {
  const snapshot = appAtomRegistry.get(environmentSnapshotAtom(thread.environmentId));
  if (snapshot === null) return [thread];
  const threads = [...snapshot.threads, ...snapshot.archivedThreads].map((entry) =>
    presentThreadShell(thread.environmentId, entry),
  );
  const root = threads.find((entry) => entry.id === thread.id) ?? thread;
  return getOwnedSubagentSubtree(threads, root);
}

function actionSubagentDescendants(
  action: ThreadListAction,
  thread: EnvironmentThreadShell,
): readonly EnvironmentThreadShell[] {
  const descendants = readThreadSubtree(thread).slice(1);
  if (action === "archive") {
    return descendants.filter((entry) => entry.archivedAt === null);
  }
  if (action === "unarchive") {
    return descendants.filter((entry) => entry.archivedAt === thread.archivedAt);
  }
  return descendants;
}

function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
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
        const mutation =
          action === "archive"
            ? archiveMutation
            : action === "unarchive"
              ? unarchiveMutation
              : deleteMutation;
        const result = await mutation({
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
    [archiveMutation, deleteMutation, onCompleted, unarchiveMutation],
  );

  return executeAction;
}

function useThreadAction(
  action: ThreadListAction,
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<void>,
  options: { readonly alwaysConfirm?: boolean } = {},
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const descendants = actionSubagentDescendants(action, thread);
      const descendantCount = descendants.length;
      const activeThreadCount = [thread, ...descendants].filter((entry) =>
        threadRuntimeIsActive(entry.runtime),
      ).length;
      if (options.alwaysConfirm !== true && descendantCount === 0 && activeThreadCount === 0) {
        void executeAction(action, thread);
        return;
      }
      const copy = threadSubtreeActionCopy({
        action,
        threadTitle: thread.title,
        descendantCount,
        activeThreadCount,
      });
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(copy.title, copy.message, [
          { text: "Cancel", style: "cancel" },
          {
            text: copy.confirmText,
            style: action === "delete" ? "destructive" : "default",
            onPress: () => {
              void executeAction(action, thread);
            },
          },
        ]);
        return;
      }
      showConfirmDialog({
        title: copy.title,
        message: copy.message,
        confirmText: copy.confirmText,
        destructive: action === "delete",
        onConfirm: () => {
          void executeAction(action, thread);
        },
      });
    },
    [action, executeAction, options.alwaysConfirm],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const executeAction = useThreadActionExecutor();
  const archiveThread = useThreadAction("archive", executeAction);
  const confirmDeleteThread = useThreadAction("delete", executeAction, {
    alwaysConfirm: true,
  });

  return { archiveThread, confirmDeleteThread };
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
  const unarchiveThread = useThreadAction("unarchive", executeAction);
  const confirmDeleteThread = useThreadAction("delete", executeAction, {
    alwaysConfirm: true,
  });

  return { unarchiveThread, confirmDeleteThread };
}
