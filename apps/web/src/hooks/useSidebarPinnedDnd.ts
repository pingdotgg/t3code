import type { SortingStrategy } from "@dnd-kit/sortable";
import { verticalListSortingStrategy } from "@dnd-kit/sortable";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  sidebarThreadKey,
  type SidebarThreadDragTransaction,
} from "../components/Sidebar.dnd.logic";
import { orderItemsByPreferredIds, planPinnedReorder } from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { useThreadActions } from "./useThreadActions";

export interface SidebarPinnedInsertionPlan {
  readonly order: readonly string[];
  readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
}

interface OptimisticPinnedOrder {
  readonly order: readonly string[];
  /** The pinOrderKey for each thread when the drop started. */
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  /** The keys written by this drop. */
  readonly assignedKeys: ReadonlyMap<string, string>;
}

function movePinnedThreadAtEdge(input: {
  keys: readonly string[];
  activeKey: string;
  overKey: string;
  edge: "before" | "after";
}): string[] | null {
  if (!input.keys.includes(input.activeKey)) return null;
  if (input.activeKey === input.overKey) return [...input.keys];

  const next = input.keys.filter((key) => key !== input.activeKey);
  const overIndex = next.indexOf(input.overKey);
  if (overIndex === -1) return null;
  const insertionIndex = overIndex + (input.edge === "after" ? 1 : 0);
  next.splice(insertionIndex, 0, input.activeKey);
  return next;
}

export function useSidebarPinnedDnd(input: {
  pinnedThreads: readonly EnvironmentThreadShell[];
  allPinnedThreads: readonly EnvironmentThreadShell[];
  reorderablePinnedKeys: ReadonlySet<string>;
  transaction: SidebarThreadDragTransaction | null;
  reorderPinnedThread: ReturnType<typeof useThreadActions>["reorderPinnedThread"];
  canPinWithOrder: (thread: EnvironmentThreadShell) => boolean;
  canReorder: (thread: EnvironmentThreadShell) => boolean;
}) {
  const pinnedReorderInFlightRef = useRef(false);
  const [optimisticPinnedOrder, setOptimisticPinnedOrder] = useState<OptimisticPinnedOrder | null>(
    null,
  );
  const orderedPinnedThreads = useMemo(() => {
    if (optimisticPinnedOrder === null) return input.pinnedThreads;
    return orderItemsByPreferredIds({
      items: input.pinnedThreads,
      preferredIds: optimisticPinnedOrder.order,
      getId: sidebarThreadKey,
    });
  }, [input.pinnedThreads, optimisticPinnedOrder]);
  const pinnedSortingOverIndex = useMemo(() => {
    const transaction = input.transaction;
    if (
      transaction === null ||
      transaction.phase !== "dragging" ||
      transaction.sourceSection !== "pinned" ||
      transaction.targetSection !== "pinned" ||
      transaction.targetThreadKey === null ||
      transaction.targetEdge === null
    ) {
      return null;
    }
    const keys = orderedPinnedThreads
      .map(sidebarThreadKey)
      .filter((threadKey) => input.reorderablePinnedKeys.has(threadKey));
    const previewOrder = movePinnedThreadAtEdge({
      keys,
      activeKey: transaction.sourceThreadKey,
      overKey: transaction.targetThreadKey,
      edge: transaction.targetEdge,
    });
    return previewOrder?.indexOf(transaction.sourceThreadKey) ?? null;
  }, [input.reorderablePinnedKeys, input.transaction, orderedPinnedThreads]);
  const pinnedSortingStrategy = useCallback<SortingStrategy>(
    (args) =>
      verticalListSortingStrategy({
        ...args,
        overIndex: pinnedSortingOverIndex ?? args.overIndex,
      }),
    [pinnedSortingOverIndex],
  );

  useEffect(() => {
    if (optimisticPinnedOrder === null) return;
    const canonical = input.pinnedThreads.filter((thread) =>
      input.reorderablePinnedKeys.has(sidebarThreadKey(thread)),
    );
    const canonicalKeys = canonical.map(sidebarThreadKey);
    const membershipChanged =
      canonicalKeys.length !== optimisticPinnedOrder.order.length ||
      canonicalKeys.some((key) => !optimisticPinnedOrder.order.includes(key));
    const foreignKeyLanded = canonical.some((thread) => {
      const threadKey = sidebarThreadKey(thread);
      const currentKey = thread.pinOrderKey ?? null;
      if (currentKey === optimisticPinnedOrder.keysAtDrop.get(threadKey)) return false;
      return currentKey !== optimisticPinnedOrder.assignedKeys.get(threadKey);
    });
    const currentKeyByThreadKey = new Map(
      canonical.map((thread) => [sidebarThreadKey(thread), thread.pinOrderKey ?? null] as const),
    );
    const allAssignmentsLanded = [...optimisticPinnedOrder.assignedKeys].every(
      ([threadKey, orderKey]) => currentKeyByThreadKey.get(threadKey) === orderKey,
    );
    const orderConfirmed =
      !membershipChanged &&
      canonicalKeys.every((key, index) => key === optimisticPinnedOrder.order[index]);
    if (membershipChanged || foreignKeyLanded || allAssignmentsLanded || orderConfirmed) {
      pinnedReorderInFlightRef.current = false;
      setOptimisticPinnedOrder(null);
    }
  }, [input.pinnedThreads, input.reorderablePinnedKeys, optimisticPinnedOrder]);

  const handlePinnedReorder = useCallback(
    (activeKey: string, overKey: string | null, targetEdge: "before" | "after" | null) => {
      if (
        pinnedReorderInFlightRef.current ||
        overKey === null ||
        targetEdge === null ||
        activeKey === overKey
      ) {
        return;
      }
      const reorderable = orderedPinnedThreads.filter((thread) =>
        input.reorderablePinnedKeys.has(sidebarThreadKey(thread)),
      );
      const keys = reorderable.map(sidebarThreadKey);
      const newOrder = movePinnedThreadAtEdge({
        keys,
        activeKey,
        overKey,
        edge: targetEdge,
      });
      if (newOrder === null || newOrder.every((key, index) => key === keys[index])) return;

      const threadByKey = new Map(
        reorderable.map((thread) => [sidebarThreadKey(thread), thread] as const),
      );
      const keysAtDrop = new Map(
        reorderable.map(
          (thread) => [sidebarThreadKey(thread), thread.pinOrderKey ?? null] as const,
        ),
      );
      const assignments = planPinnedReorder({
        orderedIds: newOrder,
        keysById: keysAtDrop,
        movedId: activeKey,
      });
      if (assignments.length === 0) return;

      pinnedReorderInFlightRef.current = true;
      setOptimisticPinnedOrder({
        order: newOrder,
        keysAtDrop,
        assignedKeys: new Map(
          assignments.map((assignment) => [assignment.id, assignment.orderKey]),
        ),
      });
      void (async () => {
        for (const assignment of assignments) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          const result = await input.reorderPinnedThread(
            scopeThreadRef(thread.environmentId, thread.id),
            assignment.orderKey,
          );
          if (result._tag === "Failure") {
            pinnedReorderInFlightRef.current = false;
            setOptimisticPinnedOrder(null);
            if (isAtomCommandInterrupted(result)) return;
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to reorder pinned threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
        }
      })();
    },
    [input.reorderPinnedThread, input.reorderablePinnedKeys, orderedPinnedThreads],
  );
  const planPinnedInsertion = useCallback(
    (transaction: SidebarThreadDragTransaction): SidebarPinnedInsertionPlan | null => {
      if (transaction.sourceSection === "pinned" || transaction.targetSection !== "pinned") {
        return null;
      }
      const existingKeys = input.allPinnedThreads.map(sidebarThreadKey);
      let insertionIndex = existingKeys.length;
      if (transaction.targetThreadKey !== null) {
        const targetIndex = existingKeys.indexOf(transaction.targetThreadKey);
        if (targetIndex !== -1) {
          insertionIndex = targetIndex + (transaction.targetEdge === "after" ? 1 : 0);
        }
      } else if (existingKeys.length === 0) {
        insertionIndex = 0;
      }
      const order = [...existingKeys];
      order.splice(insertionIndex, 0, transaction.sourceThreadKey);
      const threadByKey = new Map(
        input.allPinnedThreads.map((thread) => [sidebarThreadKey(thread), thread] as const),
      );
      threadByKey.set(transaction.sourceThreadKey, transaction.sourceThread);
      const keysById = new Map(
        input.allPinnedThreads.map((thread) => [
          sidebarThreadKey(thread),
          thread.pinOrderKey ?? null,
        ]),
      );
      keysById.set(transaction.sourceThreadKey, null);
      const assignments = planPinnedReorder({
        orderedIds: order,
        keysById,
        movedId: transaction.sourceThreadKey,
      });
      if (assignments.length === 0) return null;
      for (const assignment of assignments) {
        const thread = threadByKey.get(assignment.id);
        if (thread === undefined) return null;
        if (assignment.id === transaction.sourceThreadKey) {
          if (!input.canPinWithOrder(thread)) return null;
        } else if (!input.canReorder(thread)) {
          return null;
        }
      }
      return { order, assignments, threadByKey };
    },
    [input.allPinnedThreads, input.canPinWithOrder, input.canReorder],
  );

  return {
    optimisticPinnedOrder,
    orderedPinnedThreads,
    pinnedSortingStrategy,
    pinnedReorderInFlightRef,
    handlePinnedReorder,
    planPinnedInsertion,
  };
}
