import {
  closestCenter,
  getClientRect,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import {
  buildSidebarDndBoardEntries,
  findSidebarDndBoardThreadSection,
  moveSidebarDndBoardThread,
  type SidebarDndBoardEntry,
} from "../components/Sidebar.dnd.board";
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
  sortSettledThreadsForSidebar,
  sortSnoozedThreadsForSidebar,
  sortThreadsForSidebar,
} from "../components/Sidebar.logic";
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

function sortedDropTarget(input: {
  section: "regular" | "snoozed" | "settled";
  sourceThreadKey: string;
  threads: readonly EnvironmentThreadShell[];
}): SidebarThreadDropTarget {
  const sourceIndex = input.threads.findIndex(
    (thread) => sidebarThreadKey(thread) === input.sourceThreadKey,
  );
  if (sourceIndex === -1) {
    return { section: input.section, threadKey: null, edge: null };
  }
  const nextThread = input.threads[sourceIndex + 1];
  if (nextThread !== undefined) {
    return {
      section: input.section,
      threadKey: sidebarThreadKey(nextThread),
      edge: "before",
    };
  }
  const previousThread = input.threads[sourceIndex - 1];
  return {
    section: input.section,
    threadKey: previousThread === undefined ? null : sidebarThreadKey(previousThread),
    edge: previousThread === undefined ? null : "after",
  };
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
  const pendingSnoozePresetRef = useRef<SnoozePreset | null>(null);
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
    reorderPinnedThread: input.actions.reorderPinnedThread,
    canPinWithOrder,
    canReorder: canReorderPinnedThread,
  });
  const {
    optimisticPinnedOrder,
    orderedPinnedThreads,
    pinnedReorderInFlightRef,
    handlePinnedReorder,
    planPinnedInsertion,
  } = pinnedDnd;
  const canonicalEntries = useMemo(
    () =>
      buildSidebarDndBoardEntries({
        pinnedThreads: orderedPinnedThreads,
        regularThreads: input.activeThreads,
        snoozedThreads: input.visibleSnoozedThreads,
        settledThreads: input.renderedSettledThreads,
      }),
    [
      input.activeThreads,
      input.renderedSettledThreads,
      input.visibleSnoozedThreads,
      orderedPinnedThreads,
    ],
  );
  const canonicalEntriesRef = useRef(canonicalEntries);
  canonicalEntriesRef.current = canonicalEntries;
  const displayedEntries = transaction?.entries ?? canonicalEntries;
  const temporaryRailsVisible = transaction?.phase === "dragging";
  const layoutRevision = useMemo(
    () => ({ entries: displayedEntries, temporaryRailsVisible }),
    [displayedEntries, temporaryRailsVisible],
  );
  const layout = useSidebarDndLayout(layoutRevision);
  const captureInsertionPosition = useCallback(
    (entries: readonly SidebarDndBoardEntry[], threadKey: string) => {
      const activeIndex = entries.findIndex((entry) => entry.id === threadKey);
      const anchor = entries[activeIndex + 1] ?? entries[activeIndex - 1];
      layout.captureEntryPosition(anchor?.id ?? threadKey);
    },
    [layout],
  );
  const resolveSortedTarget = useCallback(
    (
      current: SidebarThreadDragTransaction,
      destination: "regular" | "snoozed" | "settled",
      snoozedUntil: string | null = null,
    ) => {
      let threads: readonly EnvironmentThreadShell[];
      switch (destination) {
        case "regular":
          threads = sortThreadsForSidebar([...input.activeThreads, current.sourceThread]);
          break;
        case "snoozed":
          threads = sortSnoozedThreadsForSidebar([
            ...input.visibleSnoozedThreads,
            { ...current.sourceThread, snoozedUntil },
          ]);
          break;
        case "settled":
          threads = sortSettledThreadsForSidebar([
            ...input.renderedSettledThreads,
            { ...current.sourceThread, settledAt: new Date().toISOString() },
          ]);
          break;
        default: {
          const _exhaustive: never = destination;
          return _exhaustive;
        }
      }
      return sortedDropTarget({
        section: destination,
        sourceThreadKey: current.sourceThreadKey,
        threads,
      });
    },
    [input.activeThreads, input.renderedSettledThreads, input.visibleSnoozedThreads],
  );

  const sourceStillMatchesDragStart = useCallback((current: SidebarThreadDragTransaction) => {
    const source = allThreadByKeyRef.current.get(current.sourceThreadKey);
    return (
      source !== undefined &&
      source.archivedAt === null &&
      canonicalSectionByThreadKeyRef.current.get(current.sourceThreadKey) === current.sourceSection
    );
  }, []);
  const clearTransaction = useCallback(() => {
    const current = transactionRef.current;
    snoozeDropEpochRef.current += 1;
    if (current?.phase === "awaiting-snooze-choice") {
      void readLocalApi()?.contextMenu.close();
    }
    pointerCoordinatesRef.current = null;
    pendingSnoozePresetRef.current = null;
    setTransaction(null);
  }, [setTransaction]);
  const finishTransaction = useCallback(() => {
    const current = transactionRef.current;
    if (current !== null) captureInsertionPosition(current.entries, current.sourceThreadKey);
    clearTransaction();
  }, [captureInsertionPosition, clearTransaction]);
  const beginReconciliation = useCallback(
    (reconciliation: {
      transaction: SidebarThreadDragTransaction;
      receiptSequencesByEnvironment: ReadonlyMap<EnvironmentThreadShell["environmentId"], number>;
    }) => {
      setTransaction({
        ...reconciliation.transaction,
        phase: "reconciling",
        receiptSequencesByEnvironment: reconciliation.receiptSequencesByEnvironment,
      });
    },
    [setTransaction],
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
        const committing: SidebarThreadDragTransaction = {
          ...current,
          phase: "committing",
          dropAnimation: null,
          receiptSequencesByEnvironment: null,
        };
        setTransaction(committing);
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
            transaction: committing,
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
          transaction: committing,
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
  const commitSnoozeDrop = useCallback(
    (current: SidebarThreadDragTransaction, preset: SnoozePreset) => {
      void (async () => {
        if (!sourceStillMatchesDragStart(current)) {
          finishTransaction();
          return;
        }
        const committing: SidebarThreadDragTransaction = {
          ...current,
          phase: "committing",
          dropAnimation: null,
          receiptSequencesByEnvironment: null,
        };
        setTransaction(committing);
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
          transaction: committing,
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
  const openSnoozeDropMenu = useCallback(
    (current: SidebarThreadDragTransaction, position: { x: number; y: number }) => {
      const epoch = snoozeDropEpochRef.current + 1;
      snoozeDropEpochRef.current = epoch;
      setTransaction({
        ...current,
        phase: "awaiting-snooze-choice",
        entries: current.initialEntries,
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
        const target = resolveSortedTarget(current, "snoozed", preset.snoozedUntil);
        const entries = moveSidebarDndBoardThread({
          entries: current.initialEntries,
          threadKey: current.sourceThreadKey,
          target,
        });
        pendingSnoozePresetRef.current = preset;
        captureInsertionPosition(entries, current.sourceThreadKey);
        setTransaction({
          ...current,
          phase: "dropping",
          entries,
          target,
          receiptSequencesByEnvironment: null,
        });
      })();
    },
    [
      captureInsertionPosition,
      finishTransaction,
      input.timestampFormat,
      resolveSortedTarget,
      setTransaction,
      sourceStillMatchesDragStart,
    ],
  );

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (args.pointerCoordinates !== null) pointerCoordinatesRef.current = args.pointerCoordinates;
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return [];

      if (current.sourceSection === "pinned" && args.pointerCoordinates !== null) {
        const pinnedContainers = args.droppableContainers.filter((container) => {
          if (typeof container.id !== "string") return false;
          return (
            findSidebarDndBoardThreadSection(current.initialEntries, container.id) === "pinned" &&
            input.reorderablePinnedKeys.has(container.id)
          );
        });
        const pinnedRects = pinnedContainers.flatMap((container) => {
          const rect = args.droppableRects.get(container.id);
          return rect === undefined ? [] : [rect];
        });
        const pointerInsidePinnedRows =
          pinnedRects.length > 0 &&
          args.pointerCoordinates.x >= Math.min(...pinnedRects.map((rect) => rect.left)) &&
          args.pointerCoordinates.x <= Math.max(...pinnedRects.map((rect) => rect.right)) &&
          args.pointerCoordinates.y >= Math.min(...pinnedRects.map((rect) => rect.top)) &&
          args.pointerCoordinates.y <= Math.max(...pinnedRects.map((rect) => rect.bottom));
        if (pointerInsidePinnedRows) {
          return closestCenter({
            ...args,
            droppableContainers: pinnedContainers,
          });
        }
      }

      const validCandidates = args.droppableContainers.filter((container) => {
        if (container.id === args.active.id) return false;
        const boundarySection = parseSidebarDndSectionId(container.id);
        const targetThreadKey =
          boundarySection === null && typeof container.id === "string" ? container.id : null;
        const section =
          boundarySection ??
          (targetThreadKey === null
            ? null
            : findSidebarDndBoardThreadSection(current.initialEntries, targetThreadKey));
        if (
          section === null ||
          !canDropThreadInSection(current.sourceThread, current.sourceSection, section)
        ) {
          return false;
        }
        return (
          section !== "pinned" ||
          targetThreadKey === null ||
          input.reorderablePinnedKeys.has(targetThreadKey)
        );
      });
      const visualDroppableRects = new Map(args.droppableRects);
      let visualTop = Number.POSITIVE_INFINITY;
      let visualBottom = Number.NEGATIVE_INFINITY;
      let pointerInsideBoardWidth = false;
      for (const container of validCandidates) {
        if (typeof container.id !== "string") continue;
        const measuredRect = visualDroppableRects.get(container.id);
        const node = container.node.current;
        const rect = node === null ? measuredRect : getClientRect(node);
        if (rect === undefined) continue;
        visualDroppableRects.set(container.id, rect);
        visualTop = Math.min(visualTop, rect.top);
        visualBottom = Math.max(visualBottom, rect.bottom);
        if (
          args.pointerCoordinates !== null &&
          rect.left <= args.pointerCoordinates.x &&
          args.pointerCoordinates.x <= rect.right
        ) {
          pointerInsideBoardWidth = true;
        }
      }
      const settledBoundary = validCandidates.find(
        (container) => parseSidebarDndSectionId(container.id) === "settled",
      );
      const settledBoundaryTop =
        settledBoundary === undefined
          ? null
          : (visualDroppableRects.get(settledBoundary.id)?.top ?? null);
      const collisionCandidates =
        args.pointerCoordinates !== null &&
        settledBoundaryTop !== null &&
        args.pointerCoordinates.y < settledBoundaryTop
          ? validCandidates.filter((container) => {
              const boundarySection = parseSidebarDndSectionId(container.id);
              return (
                (boundarySection ??
                  (typeof container.id === "string"
                    ? findSidebarDndBoardThreadSection(current.initialEntries, container.id)
                    : null)) !== "settled"
              );
            })
          : validCandidates;
      const pointerCollisions = pointerWithin({
        ...args,
        droppableContainers: collisionCandidates,
        droppableRects: visualDroppableRects,
      });
      if (pointerCollisions.length > 0) {
        return pointerCollisions;
      }
      if (args.pointerCoordinates !== null) {
        const { x, y } = args.pointerCoordinates;
        const viewport = layout.viewportRef.current;
        const viewportRect = viewport === null ? null : getClientRect(viewport);
        const hitAreaTop = viewportRect?.top ?? visualTop;
        const hitAreaBottom = viewportRect?.bottom ?? visualBottom;
        if (!pointerInsideBoardWidth) return [];
        return closestCenter({
          ...args,
          collisionRect:
            y < hitAreaTop || y > hitAreaBottom
              ? args.collisionRect
              : {
                  width: 0,
                  height: 0,
                  top: y,
                  bottom: y,
                  left: x,
                  right: x,
                },
          droppableContainers: collisionCandidates,
          droppableRects: visualDroppableRects,
        });
      }
      return rectIntersection({
        ...args,
        droppableContainers: validCandidates,
        droppableRects: visualDroppableRects,
      });
    },
    [canDropThreadInSection, input.reorderablePinnedKeys, layout],
  );
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (pinnedReorderInFlightRef.current) return;
      if (typeof event.active.id !== "string") return;
      const threadKey = event.active.id;
      const sourceThread = allThreadByKeyRef.current.get(threadKey);
      const sourceNode = layout.getEntryNode(threadKey);
      if (sourceThread === undefined || sourceNode === null) return;
      const sourceSection = canonicalSectionByThreadKeyRef.current.get(threadKey);
      if (sourceSection === undefined || !canDragThread(sourceThread, sourceSection)) return;
      const sourceRect = sourceNode.getBoundingClientRect();
      const pointer = getEventCoordinates(event.activatorEvent) ?? {
        x: sourceRect.left + sourceRect.width / 2,
        y: sourceRect.top + sourceRect.height / 2,
      };
      pointerCoordinatesRef.current = pointer;
      const sectionCounts = {
        pinned: orderedPinnedThreads.length,
        regular: input.activeThreads.length,
        snoozed: input.snoozedThreads.length,
        settled: input.settledThreads.length,
      } satisfies Readonly<Record<SidebarDndSection, number>>;
      const initialEntries = canonicalEntriesRef.current;
      layout.captureEntryPosition(threadKey);
      setTransaction({
        phase: "dragging",
        sourceThread,
        sourceThreadKey: threadKey,
        sourceSection,
        dragTranslation: { x: 0, y: 0 },
        sourceRect: {
          top: sourceRect.top,
          left: sourceRect.left,
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
        initialEntries,
        entries: initialEntries,
        sectionCounts,
        emptySections: new Set(
          SIDEBAR_DND_SECTIONS.filter((section) => sectionCounts[section] === 0),
        ),
        target: { section: sourceSection, threadKey, edge: null },
        dropAnimation: null,
        receiptSequencesByEnvironment: null,
      });
    },
    [
      canDragThread,
      layout,
      input.activeThreads,
      input.settledThreads.length,
      input.snoozedThreads.length,
      orderedPinnedThreads,
      pinnedReorderInFlightRef,
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
          ? null
          : findSidebarDndBoardThreadSection(current.initialEntries, targetThreadKey));
      if (destination === null) return null;
      if (!canDropThreadInSection(current.sourceThread, current.sourceSection, destination)) {
        return null;
      }
      let resolvedThreadKey = targetThreadKey;
      let targetEdge: "before" | "after" | null = null;
      if (resolvedThreadKey !== null) {
        if (destination === "pinned" && !input.reorderablePinnedKeys.has(resolvedThreadKey)) {
          return null;
        }
        if (current.sourceSection === "pinned" && destination === "pinned") {
          const sourceIndex = current.initialEntries.findIndex(
            (entry) => entry.id === current.sourceThreadKey,
          );
          const targetIndex = current.initialEntries.findIndex(
            (entry) => entry.id === resolvedThreadKey,
          );
          targetEdge =
            sourceIndex === targetIndex ? null : targetIndex < sourceIndex ? "before" : "after";
        } else {
          const targetNode = layout.getEntryNode(resolvedThreadKey);
          const targetRect = targetNode === null ? over.rect : getClientRect(targetNode);
          const pointerY =
            pointerCoordinatesRef.current?.y ?? targetRect.top + targetRect.height / 2;
          targetEdge = pointerY < targetRect.top + targetRect.height / 2 ? "before" : "after";
        }
      }
      return { section: destination, threadKey: resolvedThreadKey, edge: targetEdge };
    },
    [canDropThreadInSection, input.reorderablePinnedKeys, layout],
  );
  const resolveDragTranslation = useCallback(
    (current: SidebarThreadDragTransaction, delta: DragMoveEvent["delta"]) => {
      const sourceNode = layout.getEntryNode(current.sourceThreadKey);
      if (sourceNode === null) return current.dragTranslation;
      const sourceRect = getClientRect(sourceNode);
      return {
        x: delta.x + sourceRect.left - current.sourceRect.left,
        y: delta.y + sourceRect.top - current.sourceRect.top,
      };
    },
    [layout],
  );
  const updateDragTarget = useCallback(
    (over: DragMoveEvent["over"], dragTranslation?: DragMoveEvent["delta"]) => {
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return;
      const nextDragTranslation =
        dragTranslation === undefined
          ? current.dragTranslation
          : resolveDragTranslation(current, dragTranslation);
      const translationChanged =
        current.dragTranslation.x !== nextDragTranslation.x ||
        current.dragTranslation.y !== nextDragTranslation.y;
      const target = resolveDropTarget(current, over);
      if (target === null) {
        if (current.target === null && !translationChanged) return;
        setTransaction({
          ...current,
          dragTranslation: nextDragTranslation,
          target: null,
        });
        return;
      }
      if (
        current.target?.section === target.section &&
        current.target.threadKey === target.threadKey &&
        current.target.edge === target.edge &&
        !translationChanged
      ) {
        return;
      }
      setTransaction({
        ...current,
        dragTranslation: nextDragTranslation,
        target,
      });
    },
    [resolveDragTranslation, resolveDropTarget, setTransaction],
  );
  const completeDropAnimation = useCallback(() => {
    const current = transactionRef.current;
    if (current === null || current.phase !== "dropping" || current.target === null) return;

    const action = resolveSidebarDndAction({
      source: current.sourceSection,
      destination: current.target.section,
    });
    if (action === "noop") {
      finishTransaction();
      return;
    }
    if (action === "reorder-pinned") {
      const firstPinnedThread = current.entries.find(
        (entry) =>
          entry.kind === "thread" &&
          entry.id !== current.sourceThreadKey &&
          findSidebarDndBoardThreadSection(current.entries, entry.id) === "pinned",
      );
      handlePinnedReorder(
        current.sourceThreadKey,
        current.target.threadKey ?? firstPinnedThread?.id ?? null,
        current.target.threadKey === null ? "before" : current.target.edge,
      );
      clearTransaction();
      return;
    }
    if (action === "snooze") {
      const preset = pendingSnoozePresetRef.current;
      pendingSnoozePresetRef.current = null;
      if (preset === null) finishTransaction();
      else commitSnoozeDrop(current, preset);
      return;
    }
    const pinnedPlan = action === "pin" ? planPinnedInsertion(current) : null;
    if (action === "pin" && pinnedPlan === null) {
      finishTransaction();
      return;
    }
    commitLifecycleDrop(current, action, pinnedPlan);
  }, [
    clearTransaction,
    commitLifecycleDrop,
    commitSnoozeDrop,
    finishTransaction,
    handlePinnedReorder,
    planPinnedInsertion,
  ]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const current = transactionRef.current;
      const releasePoint = pointerCoordinatesRef.current;
      pointerCoordinatesRef.current = null;
      const target = current?.target ?? null;
      if (current === null || current.phase !== "dragging" || target === null) {
        finishTransaction();
        return;
      }
      const action = resolveSidebarDndAction({
        source: current.sourceSection,
        destination: target.section,
      });
      if (action === "noop") {
        finishTransaction();
        return;
      }
      const releaseTranslation = resolveDragTranslation(current, event.delta);
      const released: SidebarThreadDragTransaction = {
        ...current,
        target,
        dropAnimation: {
          variant: resolveSidebarDndPreviewVariant({
            source: current.sourceSection,
            destination: target.section,
          }),
          translation: releaseTranslation,
        },
      };
      if (action === "snooze") {
        if (releasePoint === null) finishTransaction();
        else {
          captureInsertionPosition(current.initialEntries, current.sourceThreadKey);
          openSnoozeDropMenu(released, releasePoint);
        }
        return;
      }
      const projectedTarget =
        target.section === "pinned" ? target : resolveSortedTarget(current, target.section);
      const projectedEntries = moveSidebarDndBoardThread({
        entries: current.initialEntries,
        threadKey: current.sourceThreadKey,
        target: projectedTarget,
      });
      if (action !== "reorder-pinned") {
        captureInsertionPosition(projectedEntries, current.sourceThreadKey);
      }
      setTransaction({
        ...released,
        phase: "dropping",
        entries: projectedEntries,
        target: projectedTarget,
      });
    },
    [
      captureInsertionPosition,
      finishTransaction,
      openSnoozeDropMenu,
      resolveDragTranslation,
      resolveSortedTarget,
      setTransaction,
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
    finishTransaction();
  }, [finishTransaction, input.threads, transaction]);
  useLayoutEffect(() => {
    if (
      transaction === null ||
      (transaction.phase !== "dragging" &&
        transaction.phase !== "dropping" &&
        transaction.phase !== "awaiting-snooze-choice")
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

  const dragPreviewVariant =
    transaction !== null && transaction.phase === "dragging"
      ? resolveSidebarDndPreviewVariant({
          source: transaction.sourceSection,
          destination: transaction.target?.section ?? null,
        })
      : null;
  const sortingOverIndex = useMemo(() => {
    if (transaction === null || transaction.phase !== "dragging" || transaction.target === null) {
      return null;
    }
    if (transaction.sourceSection === "pinned" && transaction.target.section === "pinned") {
      return null;
    }
    const projectedEntries = moveSidebarDndBoardThread({
      entries: transaction.initialEntries,
      threadKey: transaction.sourceThreadKey,
      target: transaction.target,
    });
    const index = projectedEntries.findIndex((entry) => entry.id === transaction.sourceThreadKey);
    return index === -1 ? null : index;
  }, [transaction]);

  return {
    transaction,
    viewportRef: layout.viewportRef,
    boardDnd: {
      contextProps: {
        sensors,
        collisionDetection,
        onDragStart: handleDragStart,
        onDragMove: (event: DragMoveEvent) => updateDragTarget(event.over, event.delta),
        onDragOver: (event: DragOverEvent) => updateDragTarget(event.over),
        onDragCancel: () => finishTransaction(),
        onDragEnd: handleDragEnd,
      },
      layout,
      transaction,
      entries: displayedEntries,
      threadByKey: input.allThreadByKey,
      optimisticPinnedOrderActive: optimisticPinnedOrder !== null,
      dragPreviewVariant,
      sortingOverIndex,
      completeDropAnimation,
      canDragThread,
      canDropThreadInSection,
    },
  };
}
