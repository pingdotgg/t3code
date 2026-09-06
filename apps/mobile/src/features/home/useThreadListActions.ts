import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { beginPendingThreadOrder, getPendingThreadOrder } from "../../state/thread-order";
import { createPendingThreadOrder, createThreadMovePlanner } from "../threads/threadOrder";
import { getThreadListV2OrderedSection } from "../threads/threadListV2";

/** Version skew: never send settle/unsettle to a server that predates them
    (capability defaults false on decode for older servers). */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

function environmentSupportsSnooze(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

function environmentSupportsPinning(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

function environmentSupportsPinReorder(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

function environmentSupportsTitleRegeneration(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

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

/** Resolves to true iff the action was dispatched and succeeded. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return false;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsSettlement(thread.environmentId)
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This environment's server does not support settling yet. Update the server to use Settle.",
          );
          return false;
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This thread is working. Interrupt it first, then try again.",
          );
          return false;
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
          Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
          return false;
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === "archive" || action === "unarchive" || action === "delete") {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        onCompleted?.(action, thread);
        return true;
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
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
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
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly moveThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("settle", thread)) === true,
    [executeAction],
  );
  const snoozeThread = useCallback(
    async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsSnooze(thread.environmentId)) {
          Alert.alert(
            "Could not snooze thread",
            "This environment's server does not support snoozing yet. Update the server to use Snooze.",
          );
          return false;
        }
        if (!canSnooze(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            "Could not snooze thread",
            thread.hasPendingApprovals || thread.hasPendingUserInput
              ? "This thread is waiting on you. Respond to the pending request before snoozing it."
              : "This thread is still starting a turn. Try again once it's running.",
          );
          return false;
        }

        selectionHaptic();
        const result = await snoozeMutation({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            snoozedUntil,
          },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Could not snooze thread",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread could not be snoozed.",
          );
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [snoozeMutation],
  );
  const unsnoozeThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsSnooze(thread.environmentId)) {
          Alert.alert(
            "Could not wake thread",
            "This environment's server does not support snoozing yet. Update the server to wake this thread.",
          );
          return false;
        }

        selectionHaptic();
        const result = await unsnoozeMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, reason: "user" },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Could not wake thread",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread could not be woken.",
          );
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [unsnoozeMutation],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("unsettle", thread)) === true,
    [executeAction],
  );
  const pinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsPinning(thread.environmentId)) {
        Alert.alert(
          "Could not pin thread",
          "This environment's server does not support pinning yet. Update the server to use Pin.",
        );
        return false;
      }
      selectionHaptic();
      // Same placement as web: a fresh pin takes the top of the arranged
      // run. Servers that predate reordering get the bare pin (keyless).
      let orderKey: string | undefined;
      if (environmentSupportsPinReorder(thread.environmentId)) {
        const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
        let firstKey: string | null = null;
        for (const shell of shells) {
          if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
          if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
        }
        orderKey = pinOrderKeyBetween(null, firstKey) ?? undefined;
      }
      const result = await pinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not pin thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be pinned.",
        );
        return false;
      }
      return true;
    },
    [pinMutation],
  );
  const unpinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsPinning(thread.environmentId)) {
        Alert.alert(
          "Could not unpin thread",
          "This environment's server does not support pinning yet. Update the server to use Pin.",
        );
        return false;
      }
      selectionHaptic();
      const result = await unpinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not unpin thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be unpinned.",
        );
        return false;
      }
      return true;
    },
    [unpinMutation],
  );
  const regenerateThreadTitle = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (
        thread.titleRegeneration != null ||
        titleRegenerationInFlightThreadKeys.current.has(key)
      ) {
        return false;
      }
      if (!environmentSupportsTitleRegeneration(thread.environmentId)) {
        Alert.alert(
          "Could not regenerate title",
          "This environment's server does not support title regeneration yet. Update the server to regenerate thread titles.",
        );
        return false;
      }

      titleRegenerationInFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        const result = await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, regenerateTitle: true },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Could not regenerate title",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread title could not be regenerated.",
          );
          return false;
        }
        return true;
      } finally {
        titleRegenerationInFlightThreadKeys.current.delete(key);
      }
    },
    [updateThreadMetadata],
  );

  // Plan against the complete section so filtering does not change a move.
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveMutation = useAtomCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const moveThread = useCallback(
    async (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      if (getPendingThreadOrder() !== null) return false;
      const section = thread.pinnedAt != null ? "pinned" : "active";
      const configs = appAtomRegistry.get(environmentServerConfigsAtom);
      const supportsReorder = (environmentId: EnvironmentThreadShell["environmentId"]) => {
        const capabilities = configs.get(environmentId)?.environment.capabilities;
        return section === "pinned"
          ? capabilities?.threadPinReorder === true
          : capabilities?.threadActiveReorder === true;
      };
      if (!supportsReorder(thread.environmentId)) {
        Alert.alert(
          "Could not move thread",
          "This environment's server does not support reordering these threads. Update the server to arrange them.",
        );
        return false;
      }
      const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
      const ordered = getThreadListV2OrderedSection({
        threads: shells,
        section,
        now: new Date().toISOString(),
        queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
        settlementEnvironmentIds: new Set(
          [...configs].flatMap(([id, config]) =>
            config.environment.capabilities.threadSettlement === true ? [id] : [],
          ),
        ),
        snoozeEnvironmentIds: new Set(
          [...configs].flatMap(([id, config]) =>
            config.environment.capabilities.threadSnooze === true ? [id] : [],
          ),
        ),
      });
      const assignments = createThreadMovePlanner({
        allThreads: shells,
        ordered,
        section,
        reorderableEnvironmentIds: new Set([...configs.keys()].filter(supportsReorder)),
      })(scopedThreadKey(thread.environmentId, thread.id), direction);
      if (assignments === null) return false;
      const shellByKey = new Map(
        ordered.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
      );
      selectionHaptic();
      const pending = beginPendingThreadOrder(
        createPendingThreadOrder({
          section,
          ordered,
          movedId: scopedThreadKey(thread.environmentId, thread.id),
          direction,
          assignments,
        }),
      );
      let succeeded = false;
      const reorder = section === "pinned" ? reorderPinnedMutation : reorderActiveMutation;
      try {
        for (const assignment of assignments) {
          if (!pending.isPending()) return false;
          const target = shellByKey.get(assignment.id);
          if (target === undefined) continue;
          const result = await reorder({
            environmentId: target.environmentId,
            input: { threadId: target.id, orderKey: assignment.orderKey },
          });
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            Alert.alert(
              "Could not move thread",
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "The thread could not be moved.",
            );
            // Keep confirmed keys when a later environment rejects its write.
            return false;
          }
        }
        succeeded = true;
        pending.complete();
        return true;
      } finally {
        if (!succeeded) pending.cancel();
      }
    },
    [reorderActiveMutation, reorderPinnedMutation],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    moveThread,
    regenerateThreadTitle,
  };
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
