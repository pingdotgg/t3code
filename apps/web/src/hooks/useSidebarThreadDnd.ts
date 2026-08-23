import {
  getClientRect,
  PointerSensor,
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
import { flushSync } from "react-dom";

import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../state/shell";
import {
  buildSidebarDndBoardEntries,
  findSidebarDndBoardThreadSection,
  findSortedSidebarDndDropTarget,
  moveSidebarDndBoardThread,
  type SidebarDndBoardEntry,
} from "../components/Sidebar.dnd.board";
import { detectSidebarThreadCollision } from "../components/Sidebar.dnd.collision";
import {
  parseSidebarDndSectionId,
  resolveSidebarDndAction,
  resolveSidebarDndPreviewVariant,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndAction,
  type SidebarDndSection,
  type SidebarThreadCommittingTransaction,
  type SidebarThreadDropTarget,
  type SidebarThreadDroppingTransaction,
  type SidebarThreadDraggingTransaction,
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
      return findSortedSidebarDndDropTarget({
        section: destination,
        sourceThreadKey: current.sourceThreadKey,
        threads,
      });
    },
    [input.activeThreads, input.renderedSettledThreads, input.visibleSnoozedThreads],
  );

  const currentSourceThread = useCallback((current: SidebarThreadDragTransaction) => {
    const source = allThreadByKeyRef.current.get(current.sourceThreadKey);
    if (
      source === undefined ||
      source.archivedAt !== null ||
      canonicalSectionByThreadKeyRef.current.get(current.sourceThreadKey) !== current.sourceSection
    ) {
      return null;
    }
    return source;
  }, []);
  const dropStillValid = useCallback(
    (current: SidebarThreadDragTransaction, target: SidebarThreadDropTarget) => {
      const source = currentSourceThread(current);
      return (
        source !== null && canDropThreadInSection(source, current.sourceSection, target.section)
      );
    },
    [canDropThreadInSection, currentSourceThread],
  );
  const clearTransaction = useCallback(() => {
    const current = transactionRef.current;
    snoozeDropEpochRef.current += 1;
    if (current?.phase === "awaiting-snooze-choice") {
      void readLocalApi()?.contextMenu.close();
    }
    pointerCoordinatesRef.current = null;
    setTransaction(null);
  }, [setTransaction]);
  const finishTransaction = useCallback(() => {
    const current = transactionRef.current;
    if (current !== null) captureInsertionPosition(current.entries, current.sourceThreadKey);
    clearTransaction();
  }, [captureInsertionPosition, clearTransaction]);
  const beginReconciliation = useCallback(
    (reconciliation: {
      transaction: SidebarThreadCommittingTransaction;
      receiptSequencesByEnvironment: ReadonlyMap<EnvironmentThreadShell["environmentId"], number>;
    }) => {
      if (transactionRef.current !== reconciliation.transaction) return;
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
      current: SidebarThreadDroppingTransaction,
      action: Exclude<SidebarDndAction, "noop" | "reorder-pinned" | "snooze">,
      pinnedPlan: SidebarPinnedInsertionPlan | null,
    ) => {
      void (async () => {
        if (!dropStillValid(current, current.target)) {
          finishTransaction();
          return;
        }
        const committing: SidebarThreadCommittingTransaction = {
          ...current,
          phase: "committing",
          action,
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
      dropStillValid,
    ],
  );
  const commitSnoozeDrop = useCallback(
    (current: Extract<SidebarThreadDroppingTransaction, { readonly action: "snooze" }>) => {
      void (async () => {
        if (!dropStillValid(current, current.target)) {
          finishTransaction();
          return;
        }
        const { snoozePreset, ...drop } = current;
        const committing: SidebarThreadCommittingTransaction = {
          ...drop,
          phase: "committing",
        };
        setTransaction(committing);
        const threadRef = scopeThreadRef(
          current.sourceThread.environmentId,
          current.sourceThread.id,
        );
        const outcome = await input.performSnooze(threadRef, snoozePreset);
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
            title: `Snoozed until ${snoozeWakeDescription(snoozePreset.snoozedUntil, new Date(), input.timestampFormat)}`,
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
      dropStillValid,
    ],
  );
  const openSnoozeDropMenu = useCallback(
    async (
      current: SidebarThreadDraggingTransaction,
      position: { x: number; y: number },
    ): Promise<boolean> => {
      const target = current.target;
      if (target === null) return false;
      const entries = moveSidebarDndBoardThread({
        entries: current.initialEntries,
        threadKey: current.sourceThreadKey,
        target,
      });
      const epoch = snoozeDropEpochRef.current + 1;
      snoozeDropEpochRef.current = epoch;
      captureInsertionPosition(entries, current.sourceThreadKey);
      setTransaction({
        ...current,
        phase: "awaiting-snooze-choice",
        entries,
        target,
        snoozePreset: null,
      });
      const restoreCanceledDropPresentation = () => {
        const pending = transactionRef.current;
        if (
          snoozeDropEpochRef.current !== epoch ||
          pending === null ||
          pending.phase !== "awaiting-snooze-choice" ||
          !dropStillValid(pending, target)
        ) {
          return;
        }
        captureInsertionPosition(pending.initialEntries, pending.sourceThreadKey);
        // dnd-kit snapshots the overlay as soon as cancelDrop resolves.
        flushSync(() => {
          setTransaction({
            ...pending,
            entries: pending.initialEntries,
            target: {
              section: pending.sourceSection,
              threadKey: pending.sourceThreadKey,
              edge: null,
            },
          });
        });
      };
      const api = readLocalApi();
      const menuPresets = resolveSnoozePresets(new Date(), input.timestampFormat);
      const selected =
        api === undefined
          ? null
          : await settlePromise(() =>
              api.contextMenu.show(
                menuPresets.map((preset) => ({
                  id: `snooze:${preset.id}`,
                  label: `${preset.label} (${preset.whenLabel})`,
                })),
                position,
              ),
            );
      const selectedId = selected?._tag === "Success" ? selected.value : null;
      const preset =
        selectedId === null
          ? undefined
          : menuPresets.find((candidate) => `snooze:${candidate.id}` === selectedId);
      if (
        snoozeDropEpochRef.current !== epoch ||
        preset === undefined ||
        !dropStillValid(current, target)
      ) {
        restoreCanceledDropPresentation();
        return false;
      }
      const projectedTarget = resolveSortedTarget(current, "snoozed", preset.snoozedUntil);
      const projectedEntries = moveSidebarDndBoardThread({
        entries: current.initialEntries,
        threadKey: current.sourceThreadKey,
        target: projectedTarget,
      });
      captureInsertionPosition(projectedEntries, current.sourceThreadKey);
      setTransaction({
        ...current,
        phase: "awaiting-snooze-choice",
        entries: projectedEntries,
        target: projectedTarget,
        snoozePreset: preset,
      });
      return true;
    },
    [
      captureInsertionPosition,
      input.timestampFormat,
      resolveSortedTarget,
      setTransaction,
      dropStillValid,
    ],
  );

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (args.pointerCoordinates !== null) pointerCoordinatesRef.current = args.pointerCoordinates;
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return [];
      const sourceThread = currentSourceThread(current);
      if (sourceThread === null) return [];
      return detectSidebarThreadCollision({
        args,
        transaction: current,
        sourceThread,
        reorderablePinnedKeys: input.reorderablePinnedKeys,
        canDropThreadInSection,
      });
    },
    [canDropThreadInSection, currentSourceThread, input.reorderablePinnedKeys],
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
      setTransaction({
        phase: "dragging",
        sourceThread,
        sourceThreadKey: threadKey,
        sourceSection,
        scopeKey: input.scopeKey,
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
      });
    },
    [
      canDragThread,
      layout,
      input.activeThreads,
      input.scopeKey,
      input.settledThreads.length,
      input.snoozedThreads.length,
      orderedPinnedThreads,
      pinnedReorderInFlightRef,
      setTransaction,
    ],
  );
  const resolveDropTarget = useCallback(
    (
      current: SidebarThreadDraggingTransaction,
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
  const updateDragTarget = useCallback(
    (over: DragMoveEvent["over"]) => {
      const current = transactionRef.current;
      if (current === null || current.phase !== "dragging") return;
      const target = resolveDropTarget(current, over);
      if (target === null) {
        if (current.target === null) return;
        setTransaction({
          ...current,
          target: null,
        });
        return;
      }
      if (
        current.target?.section === target.section &&
        current.target.threadKey === target.threadKey &&
        current.target.edge === target.edge
      ) {
        return;
      }
      setTransaction({
        ...current,
        target,
      });
    },
    [resolveDropTarget, setTransaction],
  );
  const handleCancelDrop = useCallback(async () => {
    const current = transactionRef.current;
    const target = current?.target ?? null;
    if (
      current === null ||
      current.phase !== "dragging" ||
      target === null ||
      !dropStillValid(current, target) ||
      resolveSidebarDndAction({
        source: current.sourceSection,
        destination: target.section,
      }) !== "snooze"
    ) {
      return false;
    }
    const releasePoint = pointerCoordinatesRef.current;
    if (releasePoint === null) return true;
    return !(await openSnoozeDropMenu(current, releasePoint));
  }, [dropStillValid, openSnoozeDropMenu]);
  const completeDropAnimation = useCallback(() => {
    const current = transactionRef.current;
    if (current === null || current.phase !== "dropping") return;
    if (!dropStillValid(current, current.target)) {
      finishTransaction();
      return;
    }

    if (current.action === "reorder-pinned") {
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
    if (current.action === "snooze") {
      commitSnoozeDrop(current);
      return;
    }
    const pinnedPlan = current.action === "pin" ? planPinnedInsertion(current) : null;
    if (current.action === "pin" && pinnedPlan === null) {
      finishTransaction();
      return;
    }
    commitLifecycleDrop(current, current.action, pinnedPlan);
  }, [
    clearTransaction,
    commitLifecycleDrop,
    commitSnoozeDrop,
    dropStillValid,
    finishTransaction,
    handlePinnedReorder,
    planPinnedInsertion,
  ]);
  const handleDragEnd = useCallback(
    (_event: DragEndEvent) => {
      const current = transactionRef.current;
      pointerCoordinatesRef.current = null;
      const target = current?.target ?? null;
      if (
        current === null ||
        (current.phase !== "dragging" && current.phase !== "awaiting-snooze-choice") ||
        target === null ||
        !dropStillValid(current, target)
      ) {
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
      if (action === "snooze") {
        if (current.phase !== "awaiting-snooze-choice" || current.snoozePreset === null) {
          finishTransaction();
          return;
        }
        setTransaction({
          ...current,
          phase: "dropping",
          action,
          snoozePreset: current.snoozePreset,
        });
        return;
      }
      const projectedTarget =
        target.section === "pinned" ? target : resolveSortedTarget(current, target.section);
      const projectedEntries = moveSidebarDndBoardThread({
        entries: current.initialEntries,
        threadKey: current.sourceThreadKey,
        target: projectedTarget,
      });
      if (action !== "reorder-pinned" && current.phase === "dragging") {
        captureInsertionPosition(projectedEntries, current.sourceThreadKey);
      }
      setTransaction({
        ...current,
        phase: "dropping",
        action,
        entries: projectedEntries,
        target: projectedTarget,
      });
    },
    [
      captureInsertionPosition,
      dropStillValid,
      finishTransaction,
      resolveSortedTarget,
      setTransaction,
    ],
  );

  useLayoutEffect(() => {
    if (transaction === null || transaction.phase !== "reconciling") return;
    if (input.isSearchingThreads || input.scopeKey !== transaction.scopeKey) return;
    for (const [environmentId, receiptSequence] of transaction.receiptSequencesByEnvironment) {
      const snapshot = appAtomRegistry.get(environmentSnapshotAtom(environmentId));
      if (snapshot === null || snapshot.snapshotSequence < receiptSequence) return;
    }
    finishTransaction();
  }, [finishTransaction, input.isSearchingThreads, input.scopeKey, input.threads, transaction]);
  useLayoutEffect(() => {
    if (transaction === null) return;
    if (input.isSearchingThreads || input.scopeKey !== transaction.scopeKey) {
      clearTransaction();
      return;
    }
    if (
      transaction.phase !== "dragging" &&
      transaction.phase !== "dropping" &&
      transaction.phase !== "awaiting-snooze-choice"
    ) {
      return;
    }
    if (currentSourceThread(transaction) === null) finishTransaction();
  }, [
    clearTransaction,
    finishTransaction,
    input.isSearchingThreads,
    input.scopeKey,
    input.threads,
    currentSourceThread,
    transaction,
  ]);

  const dragPreviewVariant =
    transaction !== null &&
    (transaction.phase === "dragging" || transaction.phase === "awaiting-snooze-choice")
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
        cancelDrop: handleCancelDrop,
        onDragStart: handleDragStart,
        onDragMove: (event: DragMoveEvent) => updateDragTarget(event.over),
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
