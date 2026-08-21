import {
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { canSettle, canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../state/shell";
import { buildSidebarDndBoardSections } from "../components/Sidebar.dnd.board";
import {
  parseSidebarDndSectionId,
  resolveSidebarDndAction,
  resolveSidebarDndPreviewVariant,
  sidebarThreadKey,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndAction,
  type SidebarDndSection,
  type SidebarThreadDropTarget,
  type SidebarThreadDragTransaction,
} from "../components/Sidebar.dnd.logic";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  type SnoozePreset,
} from "../components/Sidebar.snooze";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useSidebarDndLayout } from "./useSidebarDndLayout";
import { useSidebarPinnedDnd, type SidebarPinnedInsertionPlan } from "./useSidebarPinnedDnd";
import type { useThreadActions } from "./useThreadActions";

interface SidebarThreadDndCapabilities {
  readonly threadPinning?: boolean;
  readonly threadPinReorder?: boolean;
  readonly threadSettlement?: boolean;
  readonly threadSnooze?: boolean;
}

type SidebarThreadDndActions = Pick<
  ReturnType<typeof useThreadActions>,
  | "pinThread"
  | "unpinThread"
  | "reorderPinnedThread"
  | "settleThread"
  | "unsettleThread"
  | "unsnoozeThread"
>;

type SidebarSnoozeOutcome =
  | { readonly status: "skipped" | "interrupted" }
  | { readonly status: "failure"; readonly error: unknown }
  | { readonly status: "success"; readonly sequence: number };

export function useSidebarThreadDnd(input: {
  threads: readonly EnvironmentThreadShell[];
  pinnedThreads: readonly EnvironmentThreadShell[];
  allPinnedThreads: readonly EnvironmentThreadShell[];
  activeThreads: readonly EnvironmentThreadShell[];
  snoozedThreads: readonly EnvironmentThreadShell[];
  visibleSnoozedThreads: readonly EnvironmentThreadShell[];
  settledThreads: readonly EnvironmentThreadShell[];
  renderedSettledThreads: readonly EnvironmentThreadShell[];
  reorderablePinnedKeys: ReadonlySet<string>;
  allThreadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  canonicalSectionByThreadKey: ReadonlyMap<string, SidebarDndSection>;
  isSearchingThreads: boolean;
  scopeKey: string | null;
  timestampFormat: TimestampFormat;
  getCapabilities: (thread: EnvironmentThreadShell) => SidebarThreadDndCapabilities | undefined;
  actions: SidebarThreadDndActions;
  performSnooze: (
    threadRef: ScopedThreadRef,
    preset: SnoozePreset,
  ) => Promise<SidebarSnoozeOutcome>;
  attemptUnsnooze: (threadRef: ScopedThreadRef) => void;
  planForwardNavigation: (threadKey: string) => (() => void) | null;
  isRouteThread: (threadKey: string) => boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [transaction, setTransactionState] = useState<SidebarThreadDragTransaction | null>(null);
  const transactionRef = useRef<SidebarThreadDragTransaction | null>(null);
  const setTransaction = useCallback(
    (
      next:
        | SidebarThreadDragTransaction
        | null
        | ((current: SidebarThreadDragTransaction | null) => SidebarThreadDragTransaction | null),
    ) => {
      const resolved = typeof next === "function" ? next(transactionRef.current) : next;
      transactionRef.current = resolved;
      setTransactionState(resolved);
    },
    [],
  );
  const allThreadByKeyRef = useRef(input.allThreadByKey);
  allThreadByKeyRef.current = input.allThreadByKey;
  const canonicalSectionByThreadKeyRef = useRef(input.canonicalSectionByThreadKey);
  canonicalSectionByThreadKeyRef.current = input.canonicalSectionByThreadKey;
  const pointerCoordinatesRef = useRef<{ x: number; y: number } | null>(null);
  const snoozeDropEpochRef = useRef(0);

  const canPinWithOrder = useCallback(
    (thread: EnvironmentThreadShell) => {
      const capabilities = input.getCapabilities(thread);
      return capabilities?.threadPinning === true && capabilities.threadPinReorder === true;
    },
    [input.getCapabilities],
  );
  const canReorderPinnedThread = useCallback(
    (thread: EnvironmentThreadShell) => input.getCapabilities(thread)?.threadPinReorder === true,
    [input.getCapabilities],
  );
  const canDropThreadInSection = useCallback(
    (thread: EnvironmentThreadShell, source: SidebarDndSection, destination: SidebarDndSection) => {
      const capabilities = input.getCapabilities(thread);
      const action = resolveSidebarDndAction({ source, destination });
      switch (action) {
        case "noop":
          return true;
        case "reorder-pinned":
          return canReorderPinnedThread(thread);
        case "pin":
          return canPinWithOrder(thread);
        case "unpin":
          return capabilities?.threadPinning === true;
        case "unsettle":
          return capabilities?.threadSettlement === true;
        case "unsnooze":
          return capabilities?.threadSnooze === true;
        case "settle":
          return (
            capabilities?.threadSettlement === true &&
            canSettle(thread, { now: new Date().toISOString() })
          );
        case "snooze":
          return (
            capabilities?.threadSnooze === true &&
            canSnooze(thread, { now: new Date().toISOString() })
          );
      }
    },
    [canPinWithOrder, canReorderPinnedThread, input.getCapabilities],
  );
  const canDragThread = useCallback(
    (thread: EnvironmentThreadShell, source: SidebarDndSection) =>
      SIDEBAR_DND_SECTIONS.some((destination) => {
        const action = resolveSidebarDndAction({ source, destination });
        return action !== "noop" && canDropThreadInSection(thread, source, destination);
      }),
    [canDropThreadInSection],
  );
  const pinnedDnd = useSidebarPinnedDnd({
    pinnedThreads: input.pinnedThreads,
    allPinnedThreads: input.allPinnedThreads,
    reorderablePinnedKeys: input.reorderablePinnedKeys,
    transaction,
    reorderPinnedThread: input.actions.reorderPinnedThread,
    canPinWithOrder,
    canReorder: canReorderPinnedThread,
  });
  const {
    optimisticPinnedOrder,
    orderedPinnedThreads,
    pinnedSortingStrategy,
    pinnedReorderInFlightRef,
    handlePinnedReorder,
    planPinnedInsertion,
  } = pinnedDnd;
  const sectionThreadCounts = {
    pinned: input.pinnedThreads.length,
    regular: input.activeThreads.length,
    snoozed: input.snoozedThreads.length,
    settled: input.settledThreads.length,
  };
  const layout = useSidebarDndLayout({
    transaction,
    setTransaction,
    pinnedReorderInFlightRef,
    sectionThreadCounts,
    canDropThreadInSection,
  });
  const {
    viewportRef,
    viewportOverlayRef,
    getThreadRowNode,
    pauseLayoutMotion,
    retainLayoutAnchor,
  } = layout;

  const sourceStillMatchesDragStart = useCallback((current: SidebarThreadDragTransaction) => {
    const source = allThreadByKeyRef.current.get(current.sourceThreadKey);
    return (
      source !== undefined &&
      source.archivedAt === null &&
      canonicalSectionByThreadKeyRef.current.get(current.sourceThreadKey) === current.sourceSection
    );
  }, []);
  const finishTransaction = useCallback(
    (options: { excludeSource?: boolean } = {}) => {
      const current = transactionRef.current;
      snoozeDropEpochRef.current += 1;
      if (current?.phase === "awaiting-snooze-choice") {
        void readLocalApi()?.contextMenu.close();
      }
      pointerCoordinatesRef.current = null;
      const preferredThreadKey =
        current === null
          ? null
          : options.excludeSource
            ? (current.target?.threadKey ?? null)
            : current.sourceThreadKey;
      retainLayoutAnchor(
        preferredThreadKey === null ? null : getThreadRowNode(preferredThreadKey),
        options.excludeSource && current !== null ? current.sourceThreadKey : null,
      );
      setTransaction(null);
    },
    [getThreadRowNode, retainLayoutAnchor, setTransaction],
  );
  const beginReconciliation = useCallback(
    (reconciliation: {
      transaction: SidebarThreadDragTransaction;
      receiptSequencesByEnvironment: ReadonlyMap<EnvironmentThreadShell["environmentId"], number>;
    }) => {
      retainLayoutAnchor(null, reconciliation.transaction.sourceThreadKey);
      setTransaction({
        ...reconciliation.transaction,
        phase: "reconciling",
        receiptSequencesByEnvironment: reconciliation.receiptSequencesByEnvironment,
      });
    },
    [retainLayoutAnchor, setTransaction],
  );
  const reportDropFailure = useCallback(
    (
      title: string,
      result: Parameters<typeof isAtomCommandInterrupted>[0] & { readonly _tag: "Failure" },
    ) => {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );
  const commitLifecycleDrop = useCallback(
    (
      current: SidebarThreadDragTransaction,
      action: Exclude<SidebarDndAction, "noop" | "reorder-pinned" | "snooze">,
      pinnedPlan: SidebarPinnedInsertionPlan | null,
    ) => {
      void (async () => {
        if (!sourceStillMatchesDragStart(current)) {
          finishTransaction();
          return;
        }
        setTransaction({
          ...current,
          phase: "committing",
          receiptSequencesByEnvironment: null,
        });
        const threadRef = scopeThreadRef(
          current.sourceThread.environmentId,
          current.sourceThread.id,
        );
        const receiptSequences = new Map<EnvironmentThreadShell["environmentId"], number>();
        if (action === "pin") {
          if (pinnedPlan === null) {
            finishTransaction();
            return;
          }
          for (const assignment of pinnedPlan.assignments) {
            if (assignment.threadKey === current.sourceThreadKey) continue;
            const result = await input.actions.reorderPinnedThread(
              scopeThreadRef(assignment.thread.environmentId, assignment.thread.id),
              assignment.orderKey,
            );
            if (result._tag === "Failure") {
              finishTransaction();
              reportDropFailure("Failed to prepare pinned order", result);
              return;
            }
            receiptSequences.set(assignment.thread.environmentId, result.value.sequence);
          }
          const sourceAssignment = pinnedPlan.assignments.find(
            (assignment) => assignment.threadKey === current.sourceThreadKey,
          );
          if (sourceAssignment === undefined) {
            finishTransaction();
            return;
          }
          const result = await input.actions.pinThread(threadRef, {
            orderKey: sourceAssignment.orderKey,
          });
          if (result._tag === "Failure") {
            finishTransaction();
            reportDropFailure("Failed to pin thread", result);
            return;
          }
          receiptSequences.set(current.sourceThread.environmentId, result.value.sequence);
          beginReconciliation({
            transaction: current,
            receiptSequencesByEnvironment: receiptSequences,
          });
          return;
        }

        const navigateAfterSettle =
          action === "settle" ? input.planForwardNavigation(current.sourceThreadKey) : null;
        const result =
          action === "unpin"
            ? await input.actions.unpinThread(threadRef)
            : action === "unsettle"
              ? await input.actions.unsettleThread(threadRef)
              : action === "unsnooze"
                ? await input.actions.unsnoozeThread(threadRef)
                : await input.actions.settleThread(threadRef);
        if (result._tag === "Failure") {
          finishTransaction();
          reportDropFailure(
            action === "unpin"
              ? "Failed to unpin thread"
              : action === "unsettle"
                ? "Failed to un-settle thread"
                : action === "unsnooze"
                  ? "Failed to wake thread"
                  : "Failed to settle thread",
            result,
          );
          return;
        }
        if (action === "settle" && input.isRouteThread(current.sourceThreadKey)) {
          navigateAfterSettle?.();
        }
        receiptSequences.set(current.sourceThread.environmentId, result.value.sequence);
        beginReconciliation({
          transaction: current,
          receiptSequencesByEnvironment: receiptSequences,
        });
      })();
    },
    [
      beginReconciliation,
      finishTransaction,
      input.actions,
      input.isRouteThread,
      input.planForwardNavigation,
      reportDropFailure,
      setTransaction,
      sourceStillMatchesDragStart,
    ],
  );
  const openSnoozeDropMenu = useCallback(
    (current: SidebarThreadDragTransaction, position: { x: number; y: number }) => {
      const epoch = snoozeDropEpochRef.current + 1;
      snoozeDropEpochRef.current = epoch;
      setTransaction({
        ...current,
        phase: "awaiting-snooze-choice",
        target: { section: "snoozed", threadKey: null, edge: null },
        receiptSequencesByEnvironment: null,
      });
      void (async () => {
        const api = readLocalApi();
        if (api === undefined) {
          finishTransaction();
          return;
        }
        const menuPresets = resolveSnoozePresets(new Date(), input.timestampFormat);
        const selected = await settlePromise(() =>
          api.contextMenu.show(
            menuPresets.map((preset) => ({
              id: `snooze:${preset.id}`,
              label: `${preset.label} (${preset.whenLabel})`,
            })),
            position,
          ),
        );
        if (snoozeDropEpochRef.current !== epoch) return;
        if (selected._tag === "Failure" || selected.value === null) {
          finishTransaction();
          return;
        }
        const preset = menuPresets.find((candidate) => `snooze:${candidate.id}` === selected.value);
        if (preset === undefined || !sourceStillMatchesDragStart(current)) {
          finishTransaction();
          return;
        }
        setTransaction({
          ...current,
          phase: "committing",
          receiptSequencesByEnvironment: null,
        });
        const threadRef = scopeThreadRef(
          current.sourceThread.environmentId,
          current.sourceThread.id,
        );
        const outcome = await input.performSnooze(threadRef, preset);
        if (outcome.status === "failure") {
          finishTransaction();
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to snooze thread",
              description:
                outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
            }),
          );
          return;
        }
        if (outcome.status !== "success") {
          finishTransaction();
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), input.timestampFormat)}`,
            timeout: 5_000,
            actionProps: {
              children: "Wake",
              onClick: () => input.attemptUnsnooze(threadRef),
            },
          }),
        );
        beginReconciliation({
          transaction: current,
          receiptSequencesByEnvironment: new Map([
            [current.sourceThread.environmentId, outcome.sequence],
          ]),
        });
      })();
    },
    [
      beginReconciliation,
      finishTransaction,
      input.attemptUnsnooze,
      input.performSnooze,
      input.timestampFormat,
      setTransaction,
      sourceStillMatchesDragStart,
    ],
  );

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (args.pointerCoordinates !== null) pointerCoordinatesRef.current = args.pointerCoordinates;
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      const viewportRailSections = transactionRef.current?.viewportRailTopBySection;
      return pointerCollisions.toSorted((left, right) => {
        const priority = (id: unknown) => {
          const section = parseSidebarDndSectionId(id);
          if (section !== null && viewportRailSections?.has(section) === true) return 0;
          return section === null ? 1 : 2;
        };
        return priority(left.id) - priority(right.id);
      });
    }
    return closestCenter(args);
  }, []);
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (pinnedReorderInFlightRef.current) return;
      if (typeof event.active.id !== "string") return;
      const threadKey = event.active.id;
      const sourceThread = allThreadByKeyRef.current.get(threadKey);
      const sourceNode = getThreadRowNode(threadKey);
      if (sourceThread === undefined || sourceNode === null) return;
      const sourceSection = canonicalSectionByThreadKeyRef.current.get(threadKey);
      if (sourceSection === undefined || !canDragThread(sourceThread, sourceSection)) return;
      const sourceRect = sourceNode.getBoundingClientRect();
      const pointer = getEventCoordinates(event.activatorEvent) ?? {
        x: sourceRect.left + sourceRect.width / 2,
        y: sourceRect.top + sourceRect.height / 2,
      };
      pointerCoordinatesRef.current = pointer;
      const sections = {
        pinned: orderedPinnedThreads,
        regular: input.activeThreads,
        snoozed: input.visibleSnoozedThreads,
        settled: input.renderedSettledThreads,
      } satisfies Readonly<Record<SidebarDndSection, readonly EnvironmentThreadShell[]>>;
      pauseLayoutMotion();
      retainLayoutAnchor(sourceNode);
      setTransaction({
        phase: "dragging",
        sourceThread,
        sourceThreadKey: threadKey,
        sourceSection,
        sourceIndex: Math.max(
          0,
          sections[sourceSection].findIndex((thread) => sidebarThreadKey(thread) === threadKey),
        ),
        sourceRect: {
          width: sourceRect.width,
          height: sourceRect.height,
        },
        pointerAnchor: {
          x:
            sourceRect.width === 0
              ? 0.5
              : Math.min(1, Math.max(0, (pointer.x - sourceRect.left) / sourceRect.width)),
          y:
            sourceRect.height === 0
              ? 0.5
              : Math.min(1, Math.max(0, (pointer.y - sourceRect.top) / sourceRect.height)),
        },
        target: { section: sourceSection, threadKey, edge: null },
        receiptSequencesByEnvironment: null,
        viewportRailTopBySection: null,
      });
    },
    [
      canDragThread,
      getThreadRowNode,
      input.activeThreads,
      input.renderedSettledThreads,
      input.visibleSnoozedThreads,
      orderedPinnedThreads,
      pauseLayoutMotion,
      pinnedReorderInFlightRef,
      retainLayoutAnchor,
      setTransaction,
    ],
  );
  const resolveDropTarget = useCallback(
    (
      current: SidebarThreadDragTransaction,
      over: DragMoveEvent["over"],
    ): SidebarThreadDropTarget | null => {
      if (over === null) return null;
      const sectionDrop = parseSidebarDndSectionId(over.id);
      const targetThreadKey = sectionDrop === null && typeof over.id === "string" ? over.id : null;
      const destination =
        sectionDrop ??
        (targetThreadKey === null
          ? undefined
          : canonicalSectionByThreadKeyRef.current.get(targetThreadKey));
      if (destination === undefined) return null;
      if (!canDropThreadInSection(current.sourceThread, current.sourceSection, destination)) {
        return null;
      }
      let resolvedThreadKey = targetThreadKey;
      let targetEdge: "before" | "after" | null = null;
      const pointerY = pointerCoordinatesRef.current?.y ?? over.rect.top + over.rect.height / 2;
      if (resolvedThreadKey !== null) {
        if (destination === "pinned" && !input.reorderablePinnedKeys.has(resolvedThreadKey)) {
          return null;
        }
        targetEdge = pointerY < over.rect.top + over.rect.height / 2 ? "before" : "after";
      } else if (destination === "pinned" && orderedPinnedThreads.length > 0) {
        const before = pointerY < over.rect.top + over.rect.height / 2;
        const target = before ? orderedPinnedThreads[0] : orderedPinnedThreads.at(-1);
        if (target !== undefined) {
          resolvedThreadKey = sidebarThreadKey(target);
          targetEdge = before ? "before" : "after";
        }
      }
      return { section: destination, threadKey: resolvedThreadKey, edge: targetEdge };
    },
    [canDropThreadInSection, input.reorderablePinnedKeys, orderedPinnedThreads],
  );
  const updateDragTarget = useCallback(
    (over: DragMoveEvent["over"]) => {
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return;
      const target = resolveDropTarget(current, over);
      if (target === null) {
        if (current.target === null) return;
        setTransaction({ ...current, target: null });
        return;
      }
      if (
        current.target?.section === target.section &&
        current.target.threadKey === target.threadKey &&
        current.target.edge === target.edge
      ) {
        return;
      }
      setTransaction({ ...current, target });
    },
    [resolveDropTarget, setTransaction],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = transactionRef.current;
      const releasePoint = pointerCoordinatesRef.current;
      const target =
        current !== null && current.phase === "dragging"
          ? resolveDropTarget(current, event.over)
          : null;
      pointerCoordinatesRef.current = null;
      if (current === null || current.phase !== "dragging" || target === null) {
        finishTransaction();
        return;
      }
      const finalized = { ...current, target };
      const action = resolveSidebarDndAction({
        source: finalized.sourceSection,
        destination: finalized.target.section,
      });
      if (action === "noop") {
        finishTransaction();
        return;
      }
      if (action === "reorder-pinned") {
        handlePinnedReorder(
          finalized.sourceThreadKey,
          finalized.target.threadKey,
          finalized.target.edge,
        );
        finishTransaction();
        return;
      }
      if (action === "snooze") {
        if (releasePoint === null) finishTransaction();
        else openSnoozeDropMenu(finalized, releasePoint);
        return;
      }
      const pinnedPlan = action === "pin" ? planPinnedInsertion(finalized) : null;
      if (action === "pin" && pinnedPlan === null) {
        finishTransaction();
        return;
      }
      commitLifecycleDrop(finalized, action, pinnedPlan);
    },
    [
      commitLifecycleDrop,
      finishTransaction,
      handlePinnedReorder,
      openSnoozeDropMenu,
      planPinnedInsertion,
      resolveDropTarget,
    ],
  );

  useLayoutEffect(() => {
    if (
      transaction === null ||
      transaction.phase !== "reconciling" ||
      transaction.receiptSequencesByEnvironment === null
    ) {
      return;
    }
    for (const [environmentId, receiptSequence] of transaction.receiptSequencesByEnvironment) {
      const snapshot = appAtomRegistry.get(environmentSnapshotAtom(environmentId));
      if (snapshot === null || snapshot.snapshotSequence < receiptSequence) return;
    }
    finishTransaction({ excludeSource: true });
  }, [finishTransaction, input.threads, transaction]);
  useLayoutEffect(() => {
    if (
      transaction === null ||
      (transaction.phase !== "dragging" && transaction.phase !== "awaiting-snooze-choice")
    ) {
      return;
    }
    if (input.isSearchingThreads || !sourceStillMatchesDragStart(transaction)) {
      finishTransaction();
    }
  }, [
    finishTransaction,
    input.isSearchingThreads,
    input.scopeKey,
    input.threads,
    sourceStillMatchesDragStart,
    transaction,
  ]);

  const sections = useMemo(
    () =>
      buildSidebarDndBoardSections({
        pinnedThreads: orderedPinnedThreads,
        regularThreads: input.activeThreads,
        snoozedThreads: input.visibleSnoozedThreads,
        settledThreads: input.renderedSettledThreads,
        transaction,
      }),
    [
      input.activeThreads,
      input.renderedSettledThreads,
      input.visibleSnoozedThreads,
      orderedPinnedThreads,
      transaction,
    ],
  );
  const dropIndicator =
    transaction !== null &&
    transaction.phase !== "reconciling" &&
    transaction.target?.threadKey !== null &&
    transaction.target?.threadKey !== undefined &&
    transaction.target.edge !== null
      ? { threadKey: transaction.target.threadKey, edge: transaction.target.edge }
      : null;
  const isTemporarySectionRailVisible = useCallback(
    (section: SidebarDndSection) => {
      if (transaction === null || transaction.phase === "reconciling") return false;
      const sectionIsEmpty =
        sections[section].length === 0 &&
        (section !== "snoozed" || input.snoozedThreads.length === 0) &&
        (section !== "settled" || input.settledThreads.length === 0);
      return (
        sectionIsEmpty &&
        canDropThreadInSection(transaction.sourceThread, transaction.sourceSection, section)
      );
    },
    [
      canDropThreadInSection,
      input.settledThreads.length,
      input.snoozedThreads.length,
      sections,
      transaction,
    ],
  );
  const dragPreviewVariant =
    transaction?.phase === "dragging"
      ? resolveSidebarDndPreviewVariant({
          source: transaction.sourceSection,
          destination: transaction.target?.section ?? null,
        })
      : null;

  return {
    transaction,
    viewportRef,
    viewportOverlayRef,
    boardDnd: {
      contextProps: {
        sensors,
        collisionDetection,
        onDragStart: handleDragStart,
        onDragMove: (event: DragMoveEvent) => updateDragTarget(event.over),
        onDragCancel: () => finishTransaction(),
        onDragEnd: handleDragEnd,
      },
      layout,
      transaction,
      sections,
      reorderablePinnedKeys: input.reorderablePinnedKeys,
      pinnedSortingStrategy,
      optimisticPinnedOrderActive: optimisticPinnedOrder !== null,
      dropIndicator,
      dragPreviewVariant,
      canDragThread,
      canDropThreadInSection,
      isTemporarySectionRailVisible,
    },
  };
}
