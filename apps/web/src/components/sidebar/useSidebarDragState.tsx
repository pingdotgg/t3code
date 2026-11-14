import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";
import { useSidebarScopeState } from "./useSidebarScopeState";
import { useSidebarSearchState } from "./useSidebarSearchState";

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  SidebarSearchResultRow,
  SortableThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./SidebarThreadRow";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  belongsInSidebarWorkingShelf,
  isSidebarEnvironmentDisconnected,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  resolveSidebarReorderableThreadKeys,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "../Sidebar.logic";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { isOptimisticDropReleased } from "../SidebarParts3";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "../Sidebar.drag";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../../state/entities";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary } from "../../types";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  createInboxReturnTracker,
  isThreadWorking,
} from "@t3tools/client-runtime/state/thread-inbox";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";


export const inboxReturns = createInboxReturnTracker();


export function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}


const NO_DRAGGED_ORDER: readonly string[] = [];

const NO_DRAGGED_ORDERS: {
  readonly settledOrder: readonly string[];
  readonly activeOrder: readonly string[] | undefined;
} = { settledOrder: NO_DRAGGED_ORDER, activeOrder: undefined };


function resolveDraggedOrders(input: {
  readonly drag: { readonly activeKey: string; readonly occurredAt: string };
  readonly threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly workingShelfEnabled: boolean;
}): typeof NO_DRAGGED_ORDERS {
  const { drag, threadByKey, settledThreads, activeThreads, workingShelfEnabled } = input;
  const thread = threadByKey.get(drag.activeKey);
  if (thread === undefined) return NO_DRAGGED_ORDERS;
  const others = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((candidate) => threadShellKey(candidate) !== drag.activeKey);
  return {
    settledOrder: sortSettledThreads([
      ...others(settledThreads),
      applySidebarThreadDrop(thread, "settled", drag.occurredAt),
    ]).map(threadShellKey),
    activeOrder: workingShelfEnabled
      ? sortInboxThreadsByReturn(
          [...others(activeThreads), applySidebarThreadDrop(thread, "active", drag.occurredAt)],
          inboxReturns.returnedAt,
        ).map(threadShellKey)
      : undefined,
  };
}


function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}


function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}


const SIDEBAR_DRAG_DISTANCE = 6;


const SIDEBAR_DRAG_LABEL_HEIGHT = 24;


// Continuations that outlive a render read the open thread from the router.
function readRouteThreadKey(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  const ref = resolveActiveThreadRouteRef(target, draft);
  return ref === null ? null : scopedThreadKey(ref);
}

export function useSidebarDragState(props: SidebarProps, params: {
  s1: ReturnType<typeof useSidebarLookupState>,
  s2: ReturnType<typeof useSidebarScopeState>,
  s3: ReturnType<typeof useSidebarSearchState>,
  }) {
  const { s1, s2, s3 } = params;
  const { sectionByThreadKey, orderedThreadKeys, threadByKey, settledThreadKeys, snoozedThreadKeys, pinnedKeys, activeKeys, snoozeNow, projectFolders, pinnedThreads, activeThreads, workingThreads, snoozedThreads, settledCount, visibleWorkingThreads, visibleSnoozedThreads, renderedSettledThreads, visibleDraftSessionCount, routeDraftIdForRows, workingShelfExpanded, snoozedShelfExpanded, settledShelfExpanded, settledThreads, workingShelfEnabled, settledVisibleCount, pinnedKeysById, draggableThreadKeys, activeKeysById, activeReorderableThreadKeys } = s2;
  const { projectGroupsRef, projectGroups, serverConfigs, setActionSweep, dragSensorRef, threadListRef, optimisticDrop, threads, setOptimisticDrop, pinThread, confirmAndUnpinThread, contextDragKeyRef, listMotionRef, dragLabelOffsetRef, setDragState, dragState, routeRowThreadKey, settlingThreadKeysRef, settleThread, router, unpinThread, unsettleThread, unsnoozeThread, reorderActiveThread, reorderPinnedThread } = s1;
  const { orderedThreadKeysRef, threadByKeyRef, settledThreadKeysRef, snoozedThreadKeysRef, settleThreads, attemptUnsettle, attemptUnsnooze, cancelThreadDrag, isContextDrag, planForwardNavigation } = s3;
    const sectionByThreadKeyRef = useRef(sectionByThreadKey);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed list data to refs read by stable drag and sweep callbacks
    useLayoutEffect(() => {
      projectGroupsRef.current = projectGroups;
      orderedThreadKeysRef.current = orderedThreadKeys;
      threadByKeyRef.current = threadByKey;
      settledThreadKeysRef.current = settledThreadKeys;
      snoozedThreadKeysRef.current = snoozedThreadKeys;
      sectionByThreadKeyRef.current = sectionByThreadKey;
    });
    const startActionSweep = useStableCallback(
      (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
        const originKey = scopedThreadKey(threadRef);
        const originSection = sectionByThreadKeyRef.current.get(originKey);
        const canApply = (key: string) => {
          const thread = threadByKeyRef.current.get(key);
          return (
            thread !== undefined &&
            sectionByThreadKeyRef.current.get(key) === originSection &&
            serverConfigs.has(thread.environmentId)
          );
        };
        let targetKey: string | null = null;
        let sweptKeys: string[] = [];
        const sweepTo = (key: string | null) => {
          if (key === null || key === targetKey) return;
          targetKey = key;
          sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
          setActionSweep({ action, keys: new Set(sweptKeys) });
        };
        dragSensorRef.current = new SidebarPointerSensor({
          active: originKey,
          event,
          options: {
            distance: SIDEBAR_DRAG_DISTANCE,
            onAttach: () => {},
            onFinish: () => {
              dragSensorRef.current = null;
              setActionSweep(null);
            },
          },
          onPending: () => {},
          onStart: () => sweepTo(originKey),
          onMove: ({ y }) =>
            sweepTo(threadListRef.current && sidebarThreadKeyAtY(threadListRef.current, y)),
          onEnd: () => {
            const keys = sweptKeys.filter(canApply);
            if (action === "settle") {
              settleThreads(keys);
              return;
            }
            for (const key of keys) {
              const ref = parseScopedThreadKey(key);
              if (ref === null) continue;
              if (action === "unsettle") attemptUnsettle(ref);
              else attemptUnsnooze(ref);
            }
          },
          onCancel: () => {},
          onAbort: () => {},
        });
      },
    );
    // Release during render when server state catches up so canonical order appears in the same frame.
    if (
      optimisticDrop !== null &&
      isOptimisticDropReleased({
        optimisticDrop,
        threads,
        pinnedKeys,
        activeKeys,
        now: snoozeNow,
      })
    ) {
      setOptimisticDrop(null);
    }
    const attemptPin = (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await pinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    };
    const attemptUnpin = (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await confirmAndUnpinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unpin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    };

    const handleThreadDragStart = (event: DragStartEvent) => {
      const activeKey = String(event.active.id);
      contextDragKeyRef.current = activeKey;
      const activeSection = sectionByThreadKey.get(activeKey);
      if (activeSection === undefined) return;
      listMotionRef.current?.suspend();
      const list = threadListRef.current;
      const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
      if (list && header) {
        const listRect = list.getBoundingClientRect();
        const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
        dragLabelOffsetRef.current =
          header.getBoundingClientRect().top - listRect.top + SIDEBAR_DRAG_LABEL_HEIGHT * scale;
      } else {
        dragLabelOffsetRef.current = 0;
      }
      setDragState({
        activeKey,
        activeSection,
        targetSection: activeSection,
        contextDrag: false,
        occurredAt: new Date().toISOString(),
        activationY:
          event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
      });
    };
    const hasProjectFolders = projectFolders !== null && projectFolders.length > 0;
    const sidebarListItemsFresh = ((): readonly SidebarListItem[] => {
      const rowsOf = (
        list: readonly EnvironmentThreadShell[],
        section: SidebarSection,
      ): SidebarListItem[] =>
        list.map((thread) => {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return { kind: "thread", key, section };
        });
      // Boring mode keeps a pinned open project or one the user filtered to, so it can start a thread.
      if (
        !hasProjectFolders &&
        pinnedThreads.length +
          activeThreads.length +
          workingThreads.length +
          snoozedThreads.length +
          settledCount ===
          0
      ) {
        return [];
      }
      const items: SidebarListItem[] = [{ kind: "marker", marker: "pinned-header" }];
      const pinnedRows = rowsOf(pinnedThreads, "pinned");
      items.push(...pinnedRows);
      items.push({ kind: "marker", marker: "pinned-divider" });
      const activeRows = rowsOf(activeThreads, "active");
      items.push({ kind: "marker", marker: "active-placeholder" });
      items.push(...activeRows);
      if (workingThreads.length > 0) {
        items.push({ kind: "marker", marker: "working-header" });
        items.push(...rowsOf(visibleWorkingThreads, "working"));
      }
      if (snoozedThreads.length > 0) {
        items.push({ kind: "marker", marker: "snoozed-header" });
        items.push(...rowsOf(visibleSnoozedThreads, "snoozed"));
      }
      items.push({ kind: "marker", marker: "settled-header" });
      const settledRows = rowsOf(renderedSettledThreads, "settled");
      items.push({ kind: "marker", marker: "settled-placeholder" });
      items.push(...settledRows);
      return items;
    })();
    // Preserve the list while streamed updates leave order unchanged to retain row memoization.
    const sidebarListItemsKey = sidebarListItemsFresh
      .map((item) => (item.kind === "thread" ? item.section + ":" + item.key : item.marker))
      .join("\n");
    const [sidebarListItemsState, setSidebarListItems] = useState(sidebarListItemsFresh);
    const [sidebarListItemsKeyState, setSidebarListItemsKeyState] = useState(sidebarListItemsKey);
    let sidebarListItems = sidebarListItemsState;
    if (sidebarListItemsKeyState !== sidebarListItemsKey) {
      setSidebarListItemsKeyState(sidebarListItemsKey);
      setSidebarListItems(sidebarListItemsFresh);
      // Update the local list too; threadByKey already omits rows moved into collapsed shelves.
      sidebarListItems = sidebarListItemsFresh;
    }
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the dnd-kit drag sensor when the dragged row leaves the list
    useEffect(() => {
      if (
        dragState !== null &&
        !sidebarListItems.some((item) => item.kind === "thread" && item.key === dragState.activeKey)
      ) {
        cancelThreadDrag();
      }
    }, [cancelThreadDrag, dragState, sidebarListItems]);
    // Only order, section, or draft changes need layout reads and motion.
    const listMotionLayoutKey = [
      sidebarListItemsKey,
      projectFolders
        ?.map((folder) => `${folder.group.projectKey}:${folder.threads.length}`)
        .join("\n") ?? "",
      visibleDraftSessionCount,
      routeDraftIdForRows ?? "",
    ].join("\0");
    const listMotionAnimate =
      dragState === null && sidebarListItems.length + visibleDraftSessionCount > 0;
    // Cache on both fields so layout-key changes trigger the effect even when animate is unchanged.
    const listMotionPass = { layoutKey: listMotionLayoutKey, animate: listMotionAnimate };
    const shelfExpansionKey = [workingShelfExpanded, snoozedShelfExpanded, settledShelfExpanded].join(
      ":",
    );
    const previousShelfExpansionKeyRef = useRef(shelfExpansionKey);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list motion controller to animate or not after each layout-affecting commit
    useLayoutEffect(() => {
      // Shelf rows would travel over stationary headers below the bottom-anchored shelf.
      const shelvesUnchanged = previousShelfExpansionKeyRef.current === shelfExpansionKey;
      previousShelfExpansionKeyRef.current = shelfExpansionKey;
      listMotionRef.current?.update(listMotionPass.animate && shelvesUnchanged);
    }, [listMotionPass, shelfExpansionKey]);
    const handleThreadDragOver = (event: DragOverEvent) => {
      const target = event.over
        ? resolveSidebarDropTarget(sidebarListItems, String(event.active.id), String(event.over.id))
        : null;
      setDragState((current) =>
        current === null || current.activeKey !== String(event.active.id)
          ? current
          : { ...current, targetSection: target?.section ?? null },
      );
    };
    const sortableIds = sidebarListItems.map(sidebarListItemId);
    // Keep non-drag orders constant to preserve sorting strategy and row identity during streaming.
    const { settledOrder: draggedSettledOrder, activeOrder: draggedActiveOrder } =
      dragState === null
        ? NO_DRAGGED_ORDERS
        : resolveDraggedOrders({
            drag: dragState,
            threadByKey,
            settledThreads,
            activeThreads,
            workingShelfEnabled,
          });
    const sidebarSortingStrategy = createSidebarSortingStrategy({
      items: sidebarListItems,
      enabled: !isContextDrag,
      boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
      settledOrder: draggedSettledOrder,
      ...(draggedActiveOrder === undefined ? {} : { activeOrder: draggedActiveOrder }),
      settledExpanded: settledShelfExpanded,
      settledVisibleCount,
      routeThreadKey: routeRowThreadKey,
      snoozedThreadCount: snoozedThreads.length,
    });
    const draggedThreadKey = dragState?.activeKey;
    const draggedFromSection = dragState?.activeSection;
    const dragActivationY = dragState?.activationY;
    const dndCollisionDetection = (() => {
      if (draggedThreadKey === undefined || draggedFromSection === undefined)
        return createSidebarCollisionDetection(() => true);
      const source = threadByKey.get(draggedThreadKey);
      if (source === undefined) return createSidebarCollisionDetection(() => false);
      return createSidebarCollisionDetection(
        (id) => {
          const target = resolveSidebarDropTarget(sidebarListItems, draggedThreadKey, id);
          if (target === null) return false;
          return (
            planSidebarThreadDrop({
              activeKey: draggedThreadKey,
              activeSection: draggedFromSection,
              activePinned: source.pinnedAt != null,
              activeSettled: source.settledOverride === "settled",
              supportsSettlement: serverConfigs.has(source.environmentId),
              target,
              pinnedOrder: pinnedKeys,
              pinnedKeysById,
              reorderableKeys: draggableThreadKeys,
              activeOrder: activeKeys,
              activeKeysById,
              activeReorderableKeys: activeReorderableThreadKeys,
              activeTimeOrdered: workingShelfEnabled,
            }).kind !== "none"
          );
        },
        {
          items: sidebarListItems,
          activationY: dragActivationY ?? null,
        },
      );
    })();
    const handleThreadDragEnd = (event: DragEndEvent) => {
      const activeKey = String(event.active.id);
      const activeSection = sectionByThreadKey.get(activeKey);
      const target =
        event.over === null
          ? null
          : resolveSidebarDropTarget(sidebarListItems, activeKey, String(event.over.id));
      const activeThread = threadByKey.get(activeKey);
      if (activeSection === undefined || target === null || activeThread === undefined) return;
      const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
      const plan = planSidebarThreadDrop({
        activeKey,
        activeSection,
        activePinned: activeThread.pinnedAt != null,
        activeSettled: activeThread.settledOverride === "settled",
        supportsSettlement: serverConfigs.has(activeThread.environmentId),
        target,
        pinnedOrder: pinnedKeys,
        pinnedKeysById,
        reorderableKeys: draggableThreadKeys,
        activeOrder: activeKeys,
        activeKeysById,
        activeReorderableKeys: activeReorderableThreadKeys,
        activeTimeOrdered: workingShelfEnabled,
      });
      if (plan.kind === "none") return;
      if (plan.kind === "settle" && settlingThreadKeysRef.current.has(activeKey)) return;
      const assignments =
        plan.kind === "pin"
          ? [
              ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
              ...plan.extraAssignments,
            ]
          : plan.kind === "reorder-pinned" || plan.kind === "move-active"
            ? plan.assignments
            : [];
      if (
        !checkThreadOperations(
          [activeKey, ...assignments.map(({ id }) => id)].flatMap((key) => {
            const thread = threadByKey.get(key);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const drop = {
        key: activeKey,
        sourceSection: activeSection,
        section: target.section,
        occurredAt: new Date().toISOString(),
        clearsSnooze:
          plan.kind === "pin" ||
          plan.kind === "settle" ||
          (plan.kind === "move-active" && plan.unsnooze),
        order: plan.kind === "settle" ? null : plan.order,
        keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
        assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
      };
      setOptimisticDrop(drop);
      void (async () => {
        const run = async (
          operation: Promise<AtomCommandResult<unknown, unknown>>,
          title: string,
        ) => {
          const result = await operation;
          if (result._tag === "Success") return true;
          setOptimisticDrop((current) => (current === drop ? null : current));
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return false;
        };
        switch (plan.kind) {
          case "settle": {
            settlingThreadKeysRef.current.add(activeKey);
            const navigateAfterSettle = planForwardNavigation(activeKey);
            const settled = await run(settleThread(threadRef), "Failed to settle thread").finally(
              () => settlingThreadKeysRef.current.delete(activeKey),
            );
            if (
              settled &&
              shouldNavigateAfterThreadPark({
                threadKey: activeKey,
                currentThreadKey: readRouteThreadKey(router),
                action: "settle",
                now: new Date().toISOString(),
                thread: readThreadShell(threadRef),
              })
            )
              navigateAfterSettle?.();
            return;
          }
          case "move-active":
            if (plan.unpin && !(await run(unpinThread(threadRef), "Failed to unpin thread"))) return;
            if (
              plan.unsettle &&
              !(await run(unsettleThread(threadRef), "Failed to un-settle thread"))
            )
              return;
            if (plan.unsnooze && !(await run(unsnoozeThread(threadRef), "Failed to wake thread")))
              return;
            break;
          case "pin":
            if (
              !(await run(
                pinThread(threadRef, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
                "Failed to pin thread",
              ))
            )
              return;
            break;
          case "reorder-pinned":
            break;
        }
        const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
        for (const assignment of keyWrites) {
          const thread = threadByKey.get(assignment.id);
          if (thread === undefined) continue;
          if (
            !(await run(
              (plan.kind === "move-active" ? reorderActiveThread : reorderPinnedThread)(
                scopeThreadRef(thread.environmentId, thread.id),
                assignment.orderKey,
              ),
              plan.kind === "move-active"
                ? "Failed to reorder active threads"
                : "Failed to reorder pinned threads",
            ))
          )
            return;
        }
      })();
    };

  return { startActionSweep, attemptPin, attemptUnpin, handleThreadDragStart, hasProjectFolders, sidebarListItems, handleThreadDragOver, sortableIds, sidebarSortingStrategy, dndCollisionDetection, handleThreadDragEnd };
}
