import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Version skew: never send settle/unsettle to a server that predates them
    (capability defaults false on decode for older servers). */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";
export type ThreadListActionResult = "succeeded" | "failed" | "skipped";

interface ThreadActionOptions {
  readonly reportFailure?: boolean;
  readonly refreshArchivedThreads?: boolean;
}

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
  settle: "settled",
  unsettle: "un-settled",
};

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `The thread could not be ${ACTION_VERBS[action]}.`;
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "unarchive") return "Could not unarchive thread";
  if (action === "settle") return "Could not settle thread";
  if (action === "unsettle") return "Could not un-settle thread";
  return "Could not delete thread";
}

/** Distinguishes successful, failed, and already-in-flight actions for bulk-action summaries. */
function useThreadActionExecutor() {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = useCallback(
    async (
      action: ThreadListAction,
      thread: EnvironmentThreadShell,
      options: ThreadActionOptions = {},
    ): Promise<ThreadListActionResult> => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return "skipped";
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsSettlement(thread.environmentId)
        ) {
          if (options.reportFailure !== false) {
            Alert.alert(
              actionFailureTitle(action),
              "This environment's server does not support settling yet. Update the server to use Settle.",
            );
          }
          return "failed";
        }
        // Settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === "settle" && !canSettle(thread, { now: new Date().toISOString() })) {
          if (options.reportFailure !== false) {
            Alert.alert(
              actionFailureTitle(action),
              "This thread still needs attention. Resolve or interrupt it first, then try again.",
            );
          }
          return "failed";
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          if (options.reportFailure !== false) {
            Alert.alert(
              actionFailureTitle(action),
              "This thread is working. Interrupt it first, then try again.",
            );
          }
          return "failed";
        }
        const result =
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag === "Failure") {
          if (options.reportFailure !== false) {
            Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
          }
          return "failed";
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (
          options.refreshArchivedThreads !== false &&
          (action === "archive" || action === "unarchive" || action === "delete")
        ) {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        return "succeeded";
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [archiveMutation, deleteMutation, settleMutation, unarchiveMutation, unsettleMutation],
  );

  return executeAction;
}

function useConfirmDeleteThread(
  executeAction: (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    options?: ThreadActionOptions,
  ) => Promise<ThreadListActionResult>,
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const title = "Delete thread?";
      const message = `“${thread.title}” will be permanently deleted, including its terminal history.`;
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(title, message, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void executeAction("delete", thread);
            },
          },
        ]);
        return;
      }
      showConfirmDialog({
        title,
        message,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void executeAction("delete", thread);
        },
      });
    },
    [executeAction],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) =>
      (await executeAction("settle", thread)) === "succeeded",
    [executeAction],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) =>
      (await executeAction("unsettle", thread)) === "succeeded",
    [executeAction],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { archiveThread, confirmDeleteThread, settleThread, unsettleThread };
}

export function useArchivedThreadListActions(): {
  readonly unarchiveThread: (
    thread: EnvironmentThreadShell,
    options?: ThreadActionOptions,
  ) => Promise<ThreadListActionResult>;
  readonly deleteThread: (
    thread: EnvironmentThreadShell,
    options?: ThreadActionOptions,
  ) => Promise<ThreadListActionResult>;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const executeAction = useThreadActionExecutor();
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell, options?: ThreadActionOptions) =>
      executeAction("unarchive", thread, options),
    [executeAction],
  );
  const deleteThread = useCallback(
    (thread: EnvironmentThreadShell, options?: ThreadActionOptions) =>
      executeAction("delete", thread, options),
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, deleteThread, confirmDeleteThread };
}
