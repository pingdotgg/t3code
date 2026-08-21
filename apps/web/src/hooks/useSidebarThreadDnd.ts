import {
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
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
  captureSidebarDndPointerAnchor,
  parseSidebarDndId,
  resolveSidebarDndAction,
  resolveSidebarDndPreviewVariant,
  sidebarThreadKey,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndAction,
  type SidebarDndSection,
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

interface SidebarThreadDropTarget {
  readonly targetSection: SidebarDndSection;
  readonly targetThreadKey: string | null;
  readonly targetEdge: "before" | "after" | null;
}

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

function sectionIndex(
  section: SidebarDndSection,
  threadKey: string,
  sections: Readonly<Record<SidebarDndSection, readonly EnvironmentThreadShell[]>>,
): number {
  const index = sections[section].findIndex((thread) => sidebarThreadKey(thread) === threadKey);
  return Math.max(0, index);
}

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
  const sectionThreadCounts = useMemo(
    () => ({
      pinned: input.pinnedThreads.length,
      regular: input.activeThreads.length,
      snoozed: input.snoozedThreads.length,
      settled: input.settledThreads.length,
    }),
    [
      input.activeThreads.length,
      input.pinnedThreads.length,
      input.settledThreads.length,
      input.snoozedThreads.length,
    ],
  );
  const layout = useSidebarDndLayout({
    transaction,
    transactionRef,
    setTransaction,
    pinnedReorderInFlightRef,
    sectionThreadCounts,
    canDropThreadInSection,
  });
  const {
    viewportRef,
    viewportOverlayRef,
    viewportRailSectionsRef,
    getThreadRowNode,
    pauseLayoutMotion,
    holdScrollRange,
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
      retainLayoutAnchor(
        options.excludeSource || current === null
          ? null
          : getThreadRowNode(current.sourceThreadKey),
        options.excludeSource && current !== null ? current.sourceThreadKey : null,
      );
      setTransaction(null);
    },
    [getThreadRowNode, retainLayoutAnchor, setTransaction],
  );
  const beginReconciliation = useCallback(
    (reconciliation: {
      transaction: SidebarThreadDragTransaction;
      destinationSection: SidebarDndSection;
      receiptSequencesByEnvironment: ReadonlyMap<EnvironmentThreadShell["environmentId"], number>;
      pinnedOrder?: readonly string[] | null;
      snoozedUntil?: string | null;
    }) => {
      retainLayoutAnchor(null, reconciliation.transaction.sourceThreadKey);
      setTransaction({
        ...reconciliation.transaction,
        phase: "reconciling",
        targetSection: reconciliation.destinationSection,
        destinationSection: reconciliation.destinationSection,
        pinnedOrder: reconciliation.pinnedOrder ?? null,
        snoozedUntil: reconciliation.snoozedUntil ?? null,
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
      destinationSection: SidebarDndSection,
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
          targetSection: destinationSection,
          destinationSection,
          pinnedOrder: pinnedPlan?.order ?? null,
          snoozedUntil: null,
          receiptSequencesByEnvironment: null,
        });
        const threadRef = scopeThreadRef(
          current.sourceThread.environmentId,
          current.sourceThread.id,
        );
        const receiptSequences = new Map<EnvironmentThreadShell["environmentId"], number>();
        const recordReceipt = (
          environmentId: EnvironmentThreadShell["environmentId"],
          sequence: number,
        ) => {
          receiptSequences.set(
            environmentId,
            Math.max(receiptSequences.get(environmentId) ?? 0, sequence),
          );
        };
        if (action === "pin") {
          if (pinnedPlan === null) {
            finishTransaction();
            return;
          }
          for (const assignment of pinnedPlan.assignments) {
            if (assignment.id === current.sourceThreadKey) continue;
            const thread = pinnedPlan.threadByKey.get(assignment.id);
            if (thread === undefined) {
              finishTransaction();
              return;
            }
            const result = await input.actions.reorderPinnedThread(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            );
            if (result._tag === "Failure") {
              finishTransaction();
              reportDropFailure("Failed to prepare pinned order", result);
              return;
            }
            recordReceipt(thread.environmentId, result.value.sequence);
          }
          const sourceAssignment = pinnedPlan.assignments.find(
            (assignment) => assignment.id === current.sourceThreadKey,
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
          recordReceipt(current.sourceThread.environmentId, result.value.sequence);
          beginReconciliation({
            transaction: current,
            destinationSection,
            receiptSequencesByEnvironment: receiptSequences,
            pinnedOrder: pinnedPlan.order,
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
        recordReceipt(current.sourceThread.environmentId, result.value.sequence);
        beginReconciliation({
          transaction: current,
          destinationSection,
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
        targetSection: "snoozed",
        destinationSection: "snoozed",
        pinnedOrder: null,
        snoozedUntil: null,
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
        const selectedId = selected.value.startsWith("snooze:")
          ? selected.value.slice("snooze:".length)
          : null;
        const preset = resolveSnoozePresets(new Date(), input.timestampFormat).find(
          (candidate) => candidate.id === selectedId,
        );
        if (preset === undefined || !sourceStillMatchesDragStart(current)) {
          finishTransaction();
          return;
        }
        setTransaction({
          ...current,
          phase: "committing",
          targetSection: "snoozed",
          destinationSection: "snoozed",
          pinnedOrder: null,
          snoozedUntil: preset.snoozedUntil,
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
          destinationSection: "snoozed",
          receiptSequencesByEnvironment: new Map([
            [current.sourceThread.environmentId, outcome.sequence],
          ]),
          snoozedUntil: preset.snoozedUntil,
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

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (args.pointerCoordinates !== null) pointerCoordinatesRef.current = args.pointerCoordinates;
      const pointerCollisions = pointerWithin(args);
      if (pointerCollisions.length > 0) {
        const viewportRailSections = viewportRailSectionsRef.current;
        return pointerCollisions.toSorted((left, right) => {
          const priority = (id: ReturnType<typeof parseSidebarDndId>) => {
            if (id?.kind === "section" && viewportRailSections.has(id.section)) return 0;
            return id?.kind === "section" ? 2 : 1;
          };
          return priority(parseSidebarDndId(left.id)) - priority(parseSidebarDndId(right.id));
        });
      }
      return closestCenter(args);
    },
    [viewportRailSectionsRef],
  );
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (pinnedReorderInFlightRef.current) return;
      const id = parseSidebarDndId(event.active.id);
      if (id === null || id.kind !== "draggable") return;
      const sourceThread = allThreadByKeyRef.current.get(id.threadKey);
      const sourceNode = getThreadRowNode(id.threadKey);
      if (sourceThread === undefined || sourceNode === null) return;
      const sourceSection = canonicalSectionByThreadKeyRef.current.get(id.threadKey);
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
      holdScrollRange();
      retainLayoutAnchor(sourceNode);
      setTransaction({
        phase: "dragging",
        sourceThread,
        sourceThreadKey: id.threadKey,
        sourceSection,
        sourceIndex: sectionIndex(sourceSection, id.threadKey, sections),
        sourceRect: {
          left: sourceRect.left,
          top: sourceRect.top,
          width: sourceRect.width,
          height: sourceRect.height,
        },
        pointerAnchor: captureSidebarDndPointerAnchor({ pointer, sourceRect }),
        targetSection: sourceSection,
        targetThreadKey: id.threadKey,
        targetEdge: null,
        destinationSection: null,
        pinnedOrder: null,
        snoozedUntil: null,
        receiptSequencesByEnvironment: null,
        viewportRailTopBySection: null,
      });
    },
    [
      canDragThread,
      getThreadRowNode,
      holdScrollRange,
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
      const overId = parseSidebarDndId(over.id);
      if (overId === null) return null;
      const destination = overId.section;
      if (!canDropThreadInSection(current.sourceThread, current.sourceSection, destination)) {
        return null;
      }
      let targetThreadKey = overId.kind === "section" ? null : overId.threadKey;
      let targetEdge: "before" | "after" | null = null;
      const pointerY = pointerCoordinatesRef.current?.y ?? over.rect.top + over.rect.height / 2;
      if (targetThreadKey !== null) {
        if (destination === "pinned" && !input.reorderablePinnedKeys.has(targetThreadKey)) {
          return null;
        }
        targetEdge = pointerY < over.rect.top + over.rect.height / 2 ? "before" : "after";
      } else if (destination === "pinned" && orderedPinnedThreads.length > 0) {
        const before = pointerY < over.rect.top + over.rect.height / 2;
        const target = before ? orderedPinnedThreads[0] : orderedPinnedThreads.at(-1);
        if (target !== undefined) {
          targetThreadKey = sidebarThreadKey(target);
          targetEdge = before ? "before" : "after";
        }
      }
      return { targetSection: destination, targetThreadKey, targetEdge };
    },
    [canDropThreadInSection, input.reorderablePinnedKeys, orderedPinnedThreads],
  );
  const capturePointerFromDragEvent = useCallback((event: DragMoveEvent) => {
    const activationCoordinates = getEventCoordinates(event.activatorEvent);
    if (activationCoordinates === null) return pointerCoordinatesRef.current;
    const pointer = {
      x: activationCoordinates.x + event.delta.x,
      y: activationCoordinates.y + event.delta.y,
    };
    pointerCoordinatesRef.current = pointer;
    return pointer;
  }, []);
  const updateDragTarget = useCallback(
    (over: DragMoveEvent["over"]) => {
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return;
      const target = resolveDropTarget(current, over);
      if (target === null) {
        if (current.targetSection === null) return;
        setTransaction({
          ...current,
          targetSection: null,
          targetThreadKey: null,
          targetEdge: null,
        });
        return;
      }
      if (
        current.targetSection === target.targetSection &&
        current.targetThreadKey === target.targetThreadKey &&
        current.targetEdge === target.targetEdge
      ) {
        return;
      }
      setTransaction({ ...current, ...target });
    },
    [resolveDropTarget, setTransaction],
  );
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      capturePointerFromDragEvent(event);
      updateDragTarget(event.over);
    },
    [capturePointerFromDragEvent, updateDragTarget],
  );
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      capturePointerFromDragEvent(event);
      updateDragTarget(event.over);
    },
    [capturePointerFromDragEvent, updateDragTarget],
  );
  const handleDragCancel = useCallback(
    (_event: DragCancelEvent) => finishTransaction(),
    [finishTransaction],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = transactionRef.current;
      const releasePoint = capturePointerFromDragEvent(event);
      const target =
        current !== null && current.phase === "dragging"
          ? resolveDropTarget(current, event.over)
          : null;
      pointerCoordinatesRef.current = null;
      if (current === null || current.phase !== "dragging" || target === null) {
        finishTransaction();
        return;
      }
      const finalized = { ...current, ...target };
      const action = resolveSidebarDndAction({
        source: finalized.sourceSection,
        destination: finalized.targetSection,
      });
      if (action === "noop") {
        finishTransaction();
        return;
      }
      if (action === "reorder-pinned") {
        handlePinnedReorder(
          finalized.sourceThreadKey,
          finalized.targetThreadKey,
          finalized.targetEdge,
        );
        finishTransaction();
        return;
      }
      if (action === "snooze") {
        openSnoozeDropMenu(
          finalized,
          releasePoint ?? {
            x: finalized.sourceRect.left + finalized.sourceRect.width / 2,
            y: finalized.sourceRect.top + finalized.sourceRect.height / 2,
          },
        );
        return;
      }
      const pinnedPlan = action === "pin" ? planPinnedInsertion(finalized) : null;
      if (action === "pin" && pinnedPlan === null) {
        finishTransaction();
        return;
      }
      commitLifecycleDrop(finalized, finalized.targetSection, action, pinnedPlan);
    },
    [
      capturePointerFromDragEvent,
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
  const dropIndicatorByThreadKey = useMemo(() => {
    const indicators = new Map<string, "before" | "after">();
    if (
      transaction === null ||
      transaction.phase === "reconciling" ||
      transaction.targetThreadKey === null ||
      transaction.targetEdge === null
    ) {
      return indicators;
    }
    indicators.set(transaction.targetThreadKey, transaction.targetEdge);
    return indicators;
  }, [transaction]);
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
          destination: transaction.targetSection,
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
        onDragMove: handleDragMove,
        onDragOver: handleDragOver,
        onDragCancel: handleDragCancel,
        onDragEnd: handleDragEnd,
      },
      layout,
      transaction,
      sections,
      reorderablePinnedKeys: input.reorderablePinnedKeys,
      pinnedSortingStrategy,
      optimisticPinnedOrderActive: optimisticPinnedOrder !== null,
      dropIndicatorByThreadKey,
      dragPreviewVariant,
      canDragThread,
      canDropThreadInSection,
      isTemporarySectionRailVisible,
    },
  };
}
