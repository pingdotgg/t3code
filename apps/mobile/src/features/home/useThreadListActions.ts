import type { ThreadMoveDestination } from "../threads/threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./thread-undo-notice";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { resolveThreadGroupFor } from "@t3tools/client-runtime/state/thread-groups";
import { AuthOrchestrationOperateScope, type ThreadPinScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useRef } from "react";

import { withThreadDismissal } from "./thread-dismissal";
import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { readEnvironmentScope } from "../../state/session";
import { clearComposerDraft } from "../../state/use-composer-drafts";
import {
  environmentThreadShells,
  steadyNavigationThreadShellsAtom,
  steadyShellsHoldingAtom,
  threadEnvironment,
} from "../../state/threads";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  threadDropBusyAtom,
} from "../../state/thread-order";
import {
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadDropLifecycle,
} from "../threads/threadOrder";
import { getThreadListV2OrderedSection } from "../threads/threadListV2";
import { threadCanArchive } from "./threadArchive";
import { resolveThreadTitleRename } from "../threads/thread-title-rename";
import {
  groupLeadArchiveDetail,
  groupLeadDeleteDetail,
  planGroupSettle,
  planGroupSnooze,
} from "../threads/threadGroupActions";

function environmentConfigLoaded(environmentId: EnvironmentThreadShell["environmentId"]) {
  return appAtomRegistry.get(environmentServerConfigsAtom).has(environmentId);
}

function environmentSupportsAutoSettleOptOut(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
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

function checkThreadOperationPermission(thread: EnvironmentThreadShell, title: string): boolean {
  if (readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return true;
  Dialog.alert(title, "This connection cannot change threads.");
  return false;
}

/**
 * The live row of a thread that a list passes to an action. A list holds its rows while an
 * environment synchronizes (`steadyNavigationThreadShellsAtom`), so its row can be older than
 * the client's data: an undo plan or a guard read from it would use replaced state.
 */
function liveThread(thread: EnvironmentThreadShell): EnvironmentThreadShell {
  return (
    appAtomRegistry
      .get(environmentThreadShells.threadShellsAtom)
      .find((row) => row.id === thread.id && row.environmentId === thread.environmentId) ?? thread
  );
}

function resolveLeadGroup(thread: EnvironmentThreadShell) {
  const group = resolveThreadGroupFor(
    appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    thread.environmentId,
    thread.id,
  );
  return group !== null && group.parent.id === thread.id ? group : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function groupCommandsReady(thread: EnvironmentThreadShell): boolean {
  return (
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) &&
    environmentConfigLoaded(thread.environmentId)
  );
}

type ThreadUndoClaim = ReturnType<typeof ThreadUndo.begin>;
type UndoRestore = {
  readonly thread: EnvironmentThreadShell;
  readonly plan: ThreadUndo.ThreadUndoPlan;
  readonly claim: ThreadUndoClaim;
};

// A group notice shows once, so its claim stands for every member claim. The notice finishes
// the claim before undo runs, so the members still current are captured at the first finish.
function combineUndoClaims(claims: ReadonlyArray<ThreadUndoClaim>) {
  let restorable: ReadonlyArray<number> | null = null;
  const currentIndexes = () => claims.flatMap((claim, index) => (claim.isCurrent() ? [index] : []));
  return {
    isCurrent: () => claims.some((claim) => claim.isCurrent()),
    finish: () => {
      restorable ??= currentIndexes();
      for (const claim of claims) claim.finish();
    },
    restorableIndexes: () => restorable ?? currentIndexes(),
  };
}

function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const latestPendingActions = useRef(new Map<string, { readonly action: ThreadListAction }>());

  const executeAction = async (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    onStarted?: () => void,
    restoreUnsettledAt?: string | null,
  ) => {
    if (!checkThreadOperationPermission(thread, actionFailureTitle(action))) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    // Drop only a repeat of the latest pending action; Settle → Un-settle → Settle must all send.
    if (latestPendingActions.current.get(key)?.action === action) {
      return false;
    }

    const pending = { action };
    latestPendingActions.current.set(key, pending);
    selectionHaptic();
    const succeeded = await (async () => {
      if (
        (action === "settle" || action === "unsettle") &&
        !environmentConfigLoaded(thread.environmentId)
      ) {
        Dialog.alert(
          actionFailureTitle(action),
          "This environment's server does not support settling yet. Update the server to use Settle.",
        );
        return false;
      }
      if (action === "archive" && !threadCanArchive(thread.runtime)) {
        Dialog.alert(
          actionFailureTitle(action),
          "This thread is working. Interrupt it first, then try again.",
        );
        return false;
      }
      if (action === "unsettle") ThreadUndo.invalidate("settle", key);
      onStarted?.();
      const result = await withThreadDismissal(
        key,
        async () =>
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: {
                  threadId: thread.id,
                  reason: "user",
                  ...(restoreUnsettledAt === undefined ? {} : { restoreUnsettledAt }),
                },
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
              }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        Dialog.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
        return false;
      }
      if (action === "archive" || action === "delete") {
        for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
      }
      if (action === "archive" || action === "unarchive" || action === "delete") {
        refreshArchivedThreadsForEnvironment(thread.environmentId);
      }
      if (action === "delete") clearComposerDraft(key);
      onCompleted?.(action, thread);
      return true;
    })();
    if (latestPendingActions.current.get(key) === pending) latestPendingActions.current.delete(key);
    return succeeded;
  };

  return executeAction;
}

// Hookless use* functions skip compilation, leaving their returned handlers unstable.
function confirmThreadDeletion(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
  thread: EnvironmentThreadShell,
) {
  if (!checkThreadOperationPermission(thread, actionFailureTitle("delete"))) return;
  const title = "Delete thread?";
  const group = resolveLeadGroup(thread);
  const message = `“${thread.title}” will be permanently deleted, including its terminal history.${
    group ? ` ${groupLeadDeleteDetail(group.workers.length)}` : ""
  }`;
  Dialog.confirm({
    title,
    message,
    confirmText: "Delete",
    destructive: true,
    onConfirm: () => {
      void executeAction("delete", thread);
    },
  });
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (
    thread: EnvironmentThreadShell,
    options?: { readonly orderKey?: string; readonly scope?: ThreadPinScope },
  ) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly setThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly moveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly renameThread: (thread: EnvironmentThreadShell) => void;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly attachThread: (thread: EnvironmentThreadShell, target: EnvironmentThreadShell) => void;
  readonly detachThread: (thread: EnvironmentThreadShell) => void;
  readonly settleGroup: (
    lead: EnvironmentThreadShell,
    options: { readonly finishedOnly: boolean },
  ) => void;
} {
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const setAutoSettleMutation = useAtomCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const regenerateTitle = useAtomCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const attachToGroupMutation = useAtomCommand(threadEnvironment.attachToGroup, {
    reportFailure: false,
  });
  const detachFromGroupMutation = useAtomCommand(threadEnvironment.detachFromGroup, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = async (thread: EnvironmentThreadShell) => {
    const group = resolveLeadGroup(thread);
    if (group) {
      if (!checkThreadOperationPermission(thread, actionFailureTitle("archive"))) return false;
      const confirmed = await new Promise<boolean>((resolve) =>
        Dialog.confirm({
          title: "Archive thread?",
          message: groupLeadArchiveDetail(group.workers.length),
          confirmText: "Archive",
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      );
      if (!confirmed) return false;
    }
    return executeAction("archive", thread);
  };
  const runUndoPlan = (
    thread: EnvironmentThreadShell,
    action: "Settled" | "Snoozed" | "Unpinned",
    plan: ThreadUndo.ThreadUndoPlan,
  ) =>
    ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        switch (step.action) {
          case "unsettle":
            return unsettleThread(thread, step.restoreUnsettledAt);
          case "unsnooze":
            return unsnoozeThread(thread);
          case "pin":
            return pinThread(thread, {
              ...(step.orderKey !== undefined ? { orderKey: step.orderKey } : {}),
              ...(step.scope !== undefined ? { scope: step.scope } : {}),
            });
          case "reorderActive": {
            const result = await reorderActiveMutation({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, orderKey: step.orderKey },
            });
            if (result._tag === "Failure") throw Cause.squash(result.cause);
            return true;
          }
          case "snooze": {
            const failureTitle =
              action === "Unpinned" ? "Could not undo unpin" : "Could not undo settle";
            if (!checkThreadOperationPermission(thread, failureTitle)) return false;
            const result = await snoozeMutation({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, snoozedUntil: step.snoozedUntil },
            });
            if (result._tag === "Failure") {
              const error = Cause.squash(result.cause);
              Dialog.alert(
                "Could not restore snooze",
                error instanceof Error ? error.message : "The thread could not be snoozed.",
              );
              return false;
            }
            return true;
          }
        }
      },
      (result) => result,
    );
  const alertUndoFailure = (error: unknown) =>
    Dialog.alert(
      "Could not undo thread action",
      error instanceof Error ? error.message : "Try again.",
    );
  const offerUndo = (
    thread: EnvironmentThreadShell,
    action: "Settled" | "Snoozed" | "Unpinned",
    claim: ThreadUndoClaim,
    plan: ThreadUndo.ThreadUndoPlan,
  ) =>
    showThreadUndoNotice({
      action,
      claim,
      undo: async () => {
        try {
          await runUndoPlan(thread, action, plan);
        } catch (error) {
          alertUndoFailure(error);
        }
      },
    });
  const offerGroupUndo = (action: "Settled" | "Snoozed", restores: ReadonlyArray<UndoRestore>) => {
    if (restores.length === 0) return;
    const claim = combineUndoClaims(restores.map((restore) => restore.claim));
    showThreadUndoNotice({
      action,
      claim,
      count: () => claim.restorableIndexes().length,
      undo: async () => {
        try {
          await Promise.all(
            claim
              .restorableIndexes()
              .map((index) => restores[index]!)
              .map(({ thread, plan }) => runUndoPlan(thread, action, plan)),
          );
        } catch (error) {
          alertUndoFailure(error);
        }
      },
    });
  };
  const settleOne = async (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const plan = ThreadUndo.planThreadUndo("settle", thread);
    let claim: ThreadUndoClaim | undefined;
    const succeeded = await executeAction("settle", thread, () => {
      ThreadUndo.invalidate("pin", key);
      ThreadUndo.invalidate("snooze", key);
      claim = ThreadUndo.begin("settle", key);
    });
    if (claim && !succeeded) claim.finish();
    return {
      succeeded,
      restore: claim && succeeded ? ({ thread, plan, claim } satisfies UndoRestore) : null,
    };
  };
  const settleGroupMembers = async (
    lead: EnvironmentThreadShell,
    workers: ReadonlyArray<EnvironmentThreadShell>,
    options: { readonly finishedOnly: boolean },
  ) => {
    const plan = planGroupSettle(lead, workers, {
      ...options,
      isInFlight: (member) => threadRuntimeIsActive(member.runtime),
    });
    if (plan.targets.length === 0) return false;
    if (!options.finishedOnly && plan.working > 0) {
      const confirmed = await new Promise<boolean>((resolve) =>
        Dialog.confirm({
          title: "Settle the whole group?",
          message: `${
            plan.working === 1
              ? "1 thread in this group is"
              : `${plan.working} threads in this group are`
          } still working.`,
          confirmText: "Settle group",
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      );
      if (!confirmed) return false;
    }
    // One member reports a missing permission or an unsupported server; not one alert each.
    const targets = groupCommandsReady(lead) ? plan.targets : plan.targets.slice(0, 1);
    const outcomes = await Promise.all(targets.map(settleOne));
    offerGroupUndo(
      "Settled",
      outcomes.flatMap(({ restore }) => (restore ? [restore] : [])),
    );
    return outcomes[0]?.succeeded ?? false;
  };
  const settleThread = async (thread: EnvironmentThreadShell) => {
    const group = resolveLeadGroup(thread);
    if (group) return settleGroupMembers(thread, group.workers, { finishedOnly: false });
    const { succeeded, restore } = await settleOne(thread);
    if (restore) offerUndo(thread, "Settled", restore.claim, restore.plan);
    return succeeded;
  };
  const snoozeOne = async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
    if (!checkThreadOperationPermission(thread, "Could not snooze thread")) {
      return { succeeded: false, restore: null };
    }
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return { succeeded: false, restore: null };
    }
    snoozeInFlightThreadKeys.current.add(key);
    const outcome = await (async (): Promise<{
      readonly succeeded: boolean;
      readonly restore: UndoRestore | null;
    }> => {
      if (!environmentConfigLoaded(thread.environmentId)) {
        Dialog.alert(
          "Could not snooze thread",
          "This environment's server does not support snoozing yet. Update the server to use Snooze.",
        );
        return { succeeded: false, restore: null };
      }
      if (!canSnooze(thread, { now: new Date().toISOString() })) {
        Dialog.alert(
          "Could not snooze thread",
          thread.hasPendingApprovals || thread.pendingSubagentRequest != null
            ? "This thread is waiting on you. Respond to the pending request before snoozing it."
            : "This thread is still starting a turn. Try again once it's running.",
        );
        return { succeeded: false, restore: null };
      }

      selectionHaptic();
      const claim = ThreadUndo.begin("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          snoozeMutation({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              snoozedUntil,
            },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        claim.finish();
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not snooze thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be snoozed.",
        );
        return { succeeded: false, restore: null };
      }
      return {
        succeeded: true,
        restore: { thread, plan: ThreadUndo.planThreadUndo("snooze"), claim },
      };
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return outcome;
  };
  const snoozeGroupMembers = async (
    lead: EnvironmentThreadShell,
    workers: ReadonlyArray<EnvironmentThreadShell>,
    snoozedUntil: string,
  ) => {
    const plan = planGroupSnooze(lead, workers, { now: nowIso() });
    // One member reports a missing permission or an unsupported server; not one alert each.
    const ready = groupCommandsReady(lead);
    const targets = ready ? plan.targets : plan.targets.slice(0, 1);
    const outcomes = await Promise.all(targets.map((member) => snoozeOne(member, snoozedUntil)));
    offerGroupUndo(
      "Snoozed",
      outcomes.flatMap(({ restore }) => (restore ? [restore] : [])),
    );
    if (ready && plan.skipped.length > 0) {
      const count = plan.skipped.length;
      Dialog.alert(
        `${count} ${count === 1 ? "thread" : "threads"} could not be snoozed`,
        "They stay active until their pending request is resolved.",
      );
    }
    return outcomes[0]?.succeeded ?? false;
  };
  const snoozeThread = async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
    const group = resolveLeadGroup(thread);
    if (group) return snoozeGroupMembers(thread, group.workers, snoozedUntil);
    const { succeeded, restore } = await snoozeOne(thread, snoozedUntil);
    if (restore) offerUndo(thread, "Snoozed", restore.claim, restore.plan);
    return succeeded;
  };
  const unsnoozeThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not wake thread")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentConfigLoaded(thread.environmentId)) {
        Dialog.alert(
          "Could not wake thread",
          "This environment's server does not support snoozing yet. Update the server to wake this thread.",
        );
        return false;
      }

      selectionHaptic();
      ThreadUndo.invalidate("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          unsnoozeMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, reason: "user" },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not wake thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be woken.",
        );
        return false;
      }
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsettleThread = async (
    thread: EnvironmentThreadShell,
    restoreUnsettledAt?: string | null,
  ) => (await executeAction("unsettle", thread, undefined, restoreUnsettledAt)) === true;
  const pinThread = async (
    thread: EnvironmentThreadShell,
    options: { readonly orderKey?: string; readonly scope?: ThreadPinScope } = {},
  ) => {
    if (!checkThreadOperationPermission(thread, "Could not pin thread")) return false;
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not pin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    let firstKey: string | null = null;
    for (const shell of shells) {
      if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
      if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
    }
    const orderKey = options.orderKey ?? pinOrderKeyBetween(null, firstKey) ?? undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
    ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        pinMutation({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            ...(orderKey !== undefined ? { orderKey } : {}),
            ...(options.scope !== undefined ? { scope: options.scope } : {}),
          },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not pin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be pinned.",
      );
      return false;
    }
    return true;
  };
  const unpinThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not unpin thread")) return false;
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not unpin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    const plan = ThreadUndo.planThreadUndo("unpin", thread);
    const claim = ThreadUndo.begin("pin", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        unpinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      claim.finish();
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not unpin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be unpinned.",
      );
      return false;
    }
    offerUndo(thread, "Unpinned", claim, plan);
    return true;
  };
  const setThreadAutoSettle = async (thread: EnvironmentThreadShell, enabled: boolean) => {
    if (!environmentSupportsAutoSettleOptOut(thread.environmentId)) {
      Dialog.alert(
        "Could not update auto-settle",
        "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.",
      );
      return false;
    }
    selectionHaptic();
    const result = await setAutoSettleMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, enabled },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not update auto-settle",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The auto-settle setting could not be changed.",
      );
      return false;
    }
    return true;
  };
  const regenerateThreadTitle = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not regenerate title")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (thread.titleRegeneration != null || titleRegenerationInFlightThreadKeys.current.has(key)) {
      return false;
    }
    if (!environmentConfigLoaded(thread.environmentId)) {
      Dialog.alert(
        "Could not regenerate title",
        "This environment's server does not support title regeneration yet. Update the server to regenerate thread titles.",
      );
      return false;
    }

    titleRegenerationInFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      const result = await regenerateTitle({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not regenerate title",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread title could not be regenerated.",
        );
        return false;
      }
      if (result.value?.status === "failed") {
        Dialog.alert(
          "Could not regenerate title",
          result.value.message ?? "The thread title could not be regenerated.",
        );
        return false;
      }
      return true;
    })();
    titleRegenerationInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const renameThread = (thread: EnvironmentThreadShell) => {
    const commit = (title: string) => {
      const resolution = resolveThreadTitleRename({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        Dialog.alert("Could not rename thread", "Thread title cannot be empty.");
        return;
      }
      if (resolution.action === "noop") return;
      selectionHaptic();
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not rename thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be renamed.",
        );
      });
    };

    Dialog.prompt({
      title: "Rename thread",
      initialValue: thread.title,
      confirmText: "Rename",
      onConfirm: commit,
    });
  };

  // Plan against the complete section so filtering does not change a move.
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveMutation = useAtomCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const moveThread = async (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    if (!checkThreadOperationPermission(thread, "Could not move thread")) return false;
    if (getPendingThreadOrder() !== null || appAtomRegistry.get(threadDropBusyAtom)) return false;
    // The rows on screen can be older than the server's while they wait to show. A move
    // planned from them could act on a pin or an order key that the server has replaced.
    if (appAtomRegistry.get(steadyShellsHoldingAtom)) return false;
    const shells = appAtomRegistry.get(steadyNavigationThreadShellsAtom);
    const current = shells.find(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (!current || current.archivedAt !== null) return false;
    thread = current;
    const section =
      typeof direction === "object" && direction.section !== undefined
        ? direction.section
        : thread.pinnedAt != null
          ? "pinned"
          : "active";
    if (section === "settled") {
      if (!environmentConfigLoaded(thread.environmentId)) return false;
      appAtomRegistry.set(threadDropBusyAtom, true);
      const settled = await settleThread(thread);
      appAtomRegistry.set(threadDropBusyAtom, false);
      return settled;
    }
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const connectedEnvironmentIds = new Set(appAtomRegistry.get(connectedEnvironmentIdsAtom));

    if (!connectedEnvironmentIds.has(thread.environmentId)) return false;

    if (!configs.has(thread.environmentId)) {
      Dialog.alert(
        "Could not move thread",
        "This environment's server does not support reordering these threads. Update the server to arrange them.",
      );
      return false;
    }
    const ordered = getThreadListV2OrderedSection({
      threads: shells,
      section,
      now: new Date().toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(configs.keys()),
      snoozeEnvironmentIds: new Set(configs.keys()),
    });
    const assignments = createThreadMovePlanner({
      allThreads: shells,
      ordered,
      section,
      reorderableEnvironmentIds: new Set(
        [...configs.keys()].filter((environmentId) => connectedEnvironmentIds.has(environmentId)),
      ),
    })(scopedThreadKey(thread.environmentId, thread.id), direction);
    if (assignments === null) return false;
    const lifecycle = threadDropLifecycle(thread, section, new Date().toISOString());
    const crossSection = !ordered.some(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    const shellByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
    );
    for (const assignment of assignments) {
      const target = shellByKey.get(assignment.id);
      if (target && !checkThreadOperationPermission(target, "Could not move thread")) return false;
    }
    selectionHaptic();
    appAtomRegistry.set(threadDropBusyAtom, true);
    const pending = crossSection
      ? null
      : beginPendingThreadOrder(
          createPendingThreadOrder({
            section,
            ordered,
            movedId: scopedThreadKey(thread.environmentId, thread.id),
            direction,
            assignments,
          }),
        );
    const reorder = section === "pinned" ? reorderPinnedMutation : reorderActiveMutation;
    const moved = await (async () => {
      if (crossSection) {
        if (section === "pinned") {
          const orderKey = assignments.find(
            ({ id }) => id === scopedThreadKey(thread.environmentId, thread.id),
          )?.orderKey;
          // Same as pinThread: older Unpinned, Settled, or Snoozed undos would fight this pin.
          ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
          const result = await pinMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, ...(orderKey === undefined ? {} : { orderKey }) },
          });
          if (result._tag === "Failure") {
            Dialog.alert("Could not pin thread", String(Cause.squash(result.cause)));
            return false;
          }
        } else {
          if (lifecycle.unpin && !(await unpinThread(thread))) return false;
          if (lifecycle.unsettle && !(await unsettleThread(thread))) return false;
          if (lifecycle.unsnooze && !(await unsnoozeThread(thread))) return false;
        }
      }
      for (const assignment of assignments) {
        if (
          crossSection &&
          section === "pinned" &&
          thread.pinnedAt == null &&
          assignment.id === scopedThreadKey(thread.environmentId, thread.id)
        )
          continue;
        if (pending !== null && !pending.isPending()) return false;
        const target = shellByKey.get(assignment.id);
        if (target === undefined) continue;
        if (!checkThreadOperationPermission(target, "Could not move thread")) return false;
        ThreadUndo.invalidate("pin", scopedThreadKey(target.environmentId, target.id));
        const result = await reorder({
          environmentId: target.environmentId,
          input: { threadId: target.id, orderKey: assignment.orderKey },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Dialog.alert(
            "Could not move thread",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread could not be moved.",
          );
          return false;
        }
      }
      pending?.complete();
      return true;
    })();
    if (!moved) pending?.cancel();
    appAtomRegistry.set(threadDropBusyAtom, false);
    return moved;
  };

  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  const attachThread = async (thread: EnvironmentThreadShell, target: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not add thread to group")) return;
    selectionHaptic();
    const result = await attachToGroupMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, parentThreadId: target.id },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not add thread to group",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be added to the group.",
      );
    }
  };
  const detachThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not remove thread from group")) return;
    selectionHaptic();
    const result = await detachFromGroupMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not remove thread from group",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be removed from the group.",
      );
    }
  };

  // `moveThread` looks up its own row, and refuses while a list holds older rows.
  return {
    archiveThread: (thread) => archiveThread(liveThread(thread)),
    confirmDeleteThread: (thread) => confirmDeleteThread(liveThread(thread)),
    settleThread: (thread) => settleThread(liveThread(thread)),
    snoozeThread: (thread, snoozedUntil) => snoozeThread(liveThread(thread), snoozedUntil),
    unsnoozeThread: (thread) => unsnoozeThread(liveThread(thread)),
    unsettleThread: (thread) => unsettleThread(liveThread(thread)),
    pinThread: (thread) => pinThread(liveThread(thread)),
    unpinThread: (thread) => unpinThread(liveThread(thread)),
    setThreadAutoSettle: (thread, enabled) => setThreadAutoSettle(liveThread(thread), enabled),
    moveThread,
    renameThread: (thread) => renameThread(liveThread(thread)),
    regenerateThreadTitle: (thread) => regenerateThreadTitle(liveThread(thread)),
    attachThread: (thread, target) => void attachThread(liveThread(thread), liveThread(target)),
    detachThread: (thread) => void detachThread(liveThread(thread)),
    settleGroup: (lead, options) => {
      const live = liveThread(lead);
      void settleGroupMembers(live, resolveLeadGroup(live)?.workers ?? [], options);
    },
  };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
    onCompleted(thread);
  };
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = (thread: EnvironmentThreadShell) => {
    void executeAction("unarchive", thread);
  };
  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return { unarchiveThread, confirmDeleteThread };
}
