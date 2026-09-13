import { useClientSettings } from "../../hooks/useSettings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { scopedTaskKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useUiStateStore } from "../../uiStateStore";
import { useComposerDraftStore, composerDraftHasUserContent } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../../state/shell";
import { toastManager } from "../ui/toast";
import {
  buildTaskSidebarInventory,
  planTaskSidebarReorder,
  type TaskSidebarDrop,
} from "../Sidebar.tasks";
import {
  applyPendingTaskSidebarDrop,
  taskSidebarDropObserved,
  type PendingTaskSidebarDrop,
  type SidebarTaskPatch,
} from "../Sidebar.taskPending";

type DropCommandResult =
  | Extract<AtomCommandResult<{ sequence: number }, unknown>, { _tag: "Success" }>
  | Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

type Input = Omit<
  Parameters<typeof buildTaskSidebarInventory>[0],
  | "drafts"
  | "collapsedTaskKeys"
  | "expandedTaskKeys"
  | "expandedSettledTaskKeys"
  | "showAllTaskKeys"
  | "taskThreadPreviewCount"
> & {
  enabled: boolean;
  routeDraftId: string | null;
  activeReorderableThreadKeys: ReadonlySet<string>;
  pinnedReorderableThreadKeys: ReadonlySet<string>;
};

/** Keep local layout preferences separate from canonical membership and lifecycle. */
export function useTaskSidebarModel(input: Input) {
  const taskActions = useTaskActions();
  const threadActions = useThreadActions();
  const showAll = useUiStateStore((state) => state.taskShowAllByKey);
  const taskThreadPreviewCount = useClientSettings(
    (settings) => settings.sidebarTaskThreadPreviewCount,
  );
  const expanded = useUiStateStore((state) => state.taskExpandedByKey);
  const settledExpanded = useUiStateStore((state) => state.taskSettledExpandedByKey);
  const sessions = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  // Subscribe to draft presence, not text changes. Typing only repaints its own row.
  const invested = useComposerDraftStore((state) =>
    !input.enabled
      ? ""
      : Object.keys(state.draftThreadsByThreadKey)
          .filter(
            (key) =>
              !state.draftThreadsByThreadKey[key]?.promotedTo &&
              composerDraftHasUserContent(state.draftsByThreadKey[key]),
          )
          .sort()
          .join("\0"),
  );
  const [frozenRouteDraft, setFrozenRouteDraft] = useState({
    id: input.routeDraftId,
    visible: input.routeDraftId !== null && invested.split("\0").includes(input.routeDraftId),
  });
  if (frozenRouteDraft.id !== input.routeDraftId)
    setFrozenRouteDraft({
      id: input.routeDraftId,
      visible: input.routeDraftId !== null && invested.split("\0").includes(input.routeDraftId),
    });
  const [pending, setPending] = useState<PendingTaskSidebarDrop | null>(null);
  const drafts = useMemo(
    () =>
      invested.split("\0").flatMap((key) => {
        const session = sessions[key];
        if (
          !session ||
          session.promotedTo ||
          (key === input.routeDraftId && !frozenRouteDraft.visible)
        )
          return [];
        return [
          {
            key: `draft:${key}`,
            environmentId: session.environmentId,
            projectId: session.projectId,
            taskId: session.taskId ?? null,
            title: useComposerDraftStore.getState().draftsByThreadKey[key]?.prompt ?? "",
          },
        ];
      }),
    [invested, sessions, input.routeDraftId, frozenRouteDraft.visible, input.search],
  );
  const projected = useMemo(
    () => applyPendingTaskSidebarDrop(input.tasks, input.threads, pending),
    [input.tasks, input.threads, pending],
  );
  const inventory = useMemo(
    () =>
      buildTaskSidebarInventory({
        ...projected,
        taskCapableEnvironmentIds: input.taskCapableEnvironmentIds,
        ...(input.threadSettlementEnvironmentIds
          ? { threadSettlementEnvironmentIds: input.threadSettlementEnvironmentIds }
          : {}),
        ...(input.threadSnoozeEnvironmentIds
          ? { threadSnoozeEnvironmentIds: input.threadSnoozeEnvironmentIds }
          : {}),
        ...(input.queuedThreadKeys ? { queuedThreadKeys: input.queuedThreadKeys } : {}),
        now: input.now,
        projectScope: input.projectScope ?? null,
        search: input.search ?? "",
        ...(input.matchingThreadKeys ? { matchingThreadKeys: input.matchingThreadKeys } : {}),
        selectedThreadKey: input.selectedThreadKey ?? null,
        selectedTaskKey: input.selectedTaskKey ?? null,
        selectedDraftKey: input.selectedDraftKey ?? null,
        snoozedExpanded: input.snoozedExpanded ?? false,
        settledExpanded: input.settledExpanded ?? false,
        settledVisibleCount: input.settledVisibleCount ?? Infinity,
        drafts,
        taskThreadPreviewCount,
        showAllTaskKeys: new Set(Object.keys(showAll).filter((key) => showAll[key] === true)),
        collapsedTaskKeys: new Set(Object.keys(expanded).filter((key) => expanded[key] === false)),
        expandedTaskKeys: new Set(Object.keys(expanded).filter((key) => expanded[key] === true)),
        expandedSettledTaskKeys: new Set(
          Object.keys(settledExpanded).filter((key) => settledExpanded[key] === true),
        ),
      }),
    [
      projected,
      showAll,
      taskThreadPreviewCount,
      drafts,
      expanded,
      settledExpanded,
      input.taskCapableEnvironmentIds,
      input.threadSettlementEnvironmentIds,
      input.threadSnoozeEnvironmentIds,
      input.queuedThreadKeys,
      input.now,
      input.projectScope,
      input.search,
      input.matchingThreadKeys,
      input.selectedThreadKey,
      input.selectedTaskKey,
      input.selectedDraftKey,
      input.snoozedExpanded,
      input.settledExpanded,
      input.settledVisibleCount,
    ],
  );
  // The ordinary shell omits archived tasks. Retain preferences until a complete
  // authoritative inventory can prove deletion; disconnects and archive are not deletion.
  useEffect(() => {
    if (!pending?.complete) return;
    const check = () => {
      const sequences = new Map(
        [...pending.receipts.keys()].map((id) => [
          id,
          appAtomRegistry.get(environmentSnapshotAtom(id))?.snapshotSequence ?? -1,
        ]),
      );
      if (taskSidebarDropObserved(pending, sequences))
        setPending((current) => (current === pending ? null : current));
    };
    const unsubscribe = [...pending.receipts.keys()].map((id) =>
      appAtomRegistry.subscribe(environmentSnapshotAtom(id), check),
    );
    check();
    return () => unsubscribe.forEach((stop) => stop());
  }, [pending]);

  const drop = useCallback(
    async (intent: TaskSidebarDrop) => {
      if (pending || !input.enabled) return;
      const taskPatches = new Map<string, SidebarTaskPatch>();
      const threadPatches = new Map<
        string,
        SidebarTaskPatch & { taskId?: import("@t3tools/contracts").TaskId | null }
      >();
      const operations: { environmentId: EnvironmentId; run: () => Promise<DropCommandResult> }[] =
        [];
      const add = (environmentId: EnvironmentId, run: () => Promise<DropCommandResult>) =>
        operations.push({ environmentId, run });
      const now = new Date().toISOString();
      if (intent.kind === "move-to-task" || intent.kind === "remove-from-task") {
        const ref = intent.threadRef;
        const thread = input.threads.find(
          (thread) => thread.id === ref.threadId && thread.environmentId === ref.environmentId,
        );
        if (!thread) return;
        const taskId = intent.kind === "move-to-task" ? intent.taskRef.taskId : null;
        if (intent.kind === "move-to-task" && ref.environmentId !== intent.taskRef.environmentId)
          return;
        threadPatches.set(scopedThreadKey(ref), {
          taskId,
          ...(taskId
            ? { pinnedAt: null, pinOrderKey: null }
            : {
                settledOverride: "active",
                unsettledAt: now,
                settledAt: null,
                snoozedUntil: null,
                snoozedAt: null,
              }),
        });
        add(ref.environmentId, () => taskActions.moveThreadToTask(ref, taskId));
        if (intent.kind === "remove-from-task") {
          if (thread.settledOverride === "settled")
            add(ref.environmentId, () => threadActions.unsettleThread(ref));
          if (thread.snoozedUntil) add(ref.environmentId, () => threadActions.unsnoozeThread(ref));
        }
      } else {
        const source = intent.source;
        const entity =
          source.kind === "task"
            ? input.tasks.find(
                (task) =>
                  task.id === source.taskRef.taskId &&
                  task.environmentId === source.taskRef.environmentId,
              )
            : input.threads.find(
                (thread) =>
                  thread.id === source.threadRef.threadId &&
                  thread.environmentId === source.threadRef.environmentId,
              );
        if (!entity) return;
        const patch: SidebarTaskPatch = {};
        const taskRef = source.kind === "task" ? source.taskRef : null;
        const threadRef = source.kind === "thread" ? source.threadRef : null;
        if (intent.section === "settled") {
          Object.assign(patch, {
            settledOverride: "settled",
            settledAt: now,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedUntil: null,
            snoozedAt: null,
          });
          if (taskRef) add(taskRef.environmentId, () => taskActions.settleTask(taskRef));
          if (threadRef) add(threadRef.environmentId, () => threadActions.settleThread(threadRef));
        } else if (intent.section === "pinned") {
          if (threadRef && "taskId" in entity && entity.taskId) return;
          Object.assign(patch, {
            pinnedAt: entity.pinnedAt ?? now,
            settledOverride: "active",
            snoozedUntil: null,
            snoozedAt: null,
          });
          if (!entity.pinnedAt || source.section !== "pinned") {
            if (taskRef) add(taskRef.environmentId, () => taskActions.pinTask(taskRef));
            if (threadRef) add(threadRef.environmentId, () => threadActions.pinThread(threadRef));
          }
        } else {
          Object.assign(patch, {
            pinnedAt: null,
            pinOrderKey: null,
            settledOverride: "active",
            snoozedUntil: null,
            snoozedAt: null,
            ...(source.section !== "active" ? { unsettledAt: now } : {}),
          });
          if (entity.pinnedAt) {
            if (taskRef) add(taskRef.environmentId, () => taskActions.unpinTask(taskRef));
            if (threadRef) add(threadRef.environmentId, () => threadActions.unpinThread(threadRef));
          }
          if (entity.settledOverride === "settled") {
            if (taskRef) add(taskRef.environmentId, () => taskActions.unsettleTask(taskRef));
            if (threadRef)
              add(threadRef.environmentId, () => threadActions.unsettleThread(threadRef));
          }
          if (entity.snoozedUntil) {
            if (taskRef) add(taskRef.environmentId, () => taskActions.unsnoozeTask(taskRef));
            if (threadRef)
              add(threadRef.environmentId, () => threadActions.unsnoozeThread(threadRef));
          }
        }
        if (taskRef) taskPatches.set(scopedTaskKey(taskRef), patch);
        if (threadRef) threadPatches.set(scopedThreadKey(threadRef), patch);
        const group = intent.taskKey ? inventory.groupsByTaskKey.get(intent.taskKey) : null;
        const rows = group
          ? [...group.live, ...group.snoozed, ...group.settled].map(threadOrderRow)
          : inventory.orderRows;
        const assignments = planTaskSidebarReorder(intent, rows);
        const allowed =
          intent.section === "pinned"
            ? input.pinnedReorderableThreadKeys
            : input.activeReorderableThreadKeys;
        if (
          assignments.some(
            (assignment) =>
              assignment.kind === "thread" && !allowed.has(scopedThreadKey(assignment.ref)),
          )
        )
          return;
        for (const assignment of assignments) {
          const order =
            intent.section === "pinned"
              ? { pinOrderKey: assignment.orderKey }
              : { activeOrderKey: assignment.orderKey };
          if (assignment.kind === "task") {
            const key = scopedTaskKey(assignment.ref);
            taskPatches.set(key, { ...taskPatches.get(key), ...order });
            add(assignment.ref.environmentId, () =>
              intent.section === "pinned"
                ? taskActions.reorderPinnedTask(assignment.ref, assignment.orderKey)
                : taskActions.reorderActiveTask(assignment.ref, assignment.orderKey),
            );
          } else {
            const key = scopedThreadKey(assignment.ref);
            threadPatches.set(key, { ...threadPatches.get(key), ...order });
            add(assignment.ref.environmentId, () =>
              intent.section === "pinned"
                ? threadActions.reorderPinnedThread(assignment.ref, assignment.orderKey)
                : threadActions.reorderActiveThread(assignment.ref, assignment.orderKey),
            );
          }
        }
      }
      if (!operations.length) return;
      const hold: PendingTaskSidebarDrop = {
        taskPatches,
        threadPatches,
        receipts: new Map(),
        complete: false,
      };
      setPending(hold);
      const receipts = new Map<EnvironmentId, number>();
      for (const operation of operations) {
        const result = await operation.run();
        if (result._tag === "Failure") {
          setPending((current) => (current === hold ? null : current));
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "Could not move item",
              description: error instanceof Error ? error.message : "Please retry.",
            });
          }
          return;
        }
        receipts.set(
          operation.environmentId,
          Math.max(receipts.get(operation.environmentId) ?? 0, result.value.sequence),
        );
      }
      setPending((current) => (current === hold ? { ...hold, complete: true, receipts } : current));
    },
    [
      pending,
      input.enabled,
      input.tasks,
      input.threads,
      input.activeReorderableThreadKeys,
      input.pinnedReorderableThreadKeys,
      taskActions,
      threadActions,
      inventory,
    ],
  );
  return { ...inventory, pending: pending !== null, drop, projected, drafts };
}
export type TaskSidebarModel = ReturnType<typeof useTaskSidebarModel>;
