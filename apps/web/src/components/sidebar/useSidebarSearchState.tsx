import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";
import { useSidebarScopeState } from "./useSidebarScopeState";

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
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@t3tools/client-runtime/state/thread-search";
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
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../../threadSelectionStore";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { findForMessageMatch, openThreadFindOnQuery } from "../chat/threadFindStore";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isMacPlatform } from "~/lib/utils";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../../state/entities";
import { registerSettleAndAdvance } from "../../settleAndAdvance";
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
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "../Sidebar.drag";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { createSidebarListMotion } from "../Sidebar.motion";
import { attachSidebarTree } from "../../lib/sidebarTree";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "../chat/threadContextDrag";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { type AnyRouter, useRouter } from "@tanstack/react-router";


const SIDEBAR_DRAG_DISTANCE = 6;


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

export function useSidebarSearchState(props: SidebarProps, params: {
  s1: ReturnType<typeof useSidebarLookupState>,
  s2: ReturnType<typeof useSidebarScopeState>,
  }) {
  const { s1, s2 } = params;
  const { threadSearch, serverMatchByKey, searchableThreads, orderedThreadKeys, threadByKey, settledThreadKeys, snoozedThreadKeys } = s2;
  const { threadSearchQuery, searchHighlightKey, setSearchHighlightKey, keybindings, clearSelection, setSelectionAnchor, isMobile, setOpenMobile, router, queuePendingFileDrop, clearPendingFileDrop, setThreadSearchQuery, isSearchingThreads, setRenamingThreadRef, setRenamingTitle, updateThreadMetadata, toggleThreadSelection, rangeSelectTo, handleNewThread, settlingThreadKeysRef, settleThread, unsettleThread, unsnoozeThread, dragLabelOffsetRef, threadListRef, listMotionRef, dragSensorRef, dragState, contextDragKeyRef, setDragState, threads } = s1;
    const [shownMessageOrder, setShownMessageOrder] = useState<ShownOrder | null>(null);
    const messageOrder = nextShownOrder(
      shownMessageOrder,
      threadSearch.query,
      [...serverMatchByKey.keys()],
      Number.POSITIVE_INFINITY,
    );
    if (messageOrder !== shownMessageOrder) setShownMessageOrder(messageOrder);
    const { titleMatches: threadTitleResults, contentMatches: threadContentResults } =
      searchSidebarThreads(searchableThreads, threadSearchQuery, new Set(messageOrder.keys));
    const threadSearchResults = [...threadTitleResults, ...threadContentResults];
    // Only rows listed for their messages show one, and open find on it.
    const threadSearchMatchByKey = new Map(
      threadContentResults.flatMap((thread) => {
        const key = threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        });
        const match = serverMatchByKey.get(key);
        return match ? [[key, match] as const] : [];
      }),
    );
    const threadSearchResultKeys = threadSearchResults.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );

    // The highlight follows its thread, so rows that arrive late do not move
    // it under Enter; a new query starts at the top.
    const activeSearchResultIndex = Math.max(
      0,
      searchHighlightKey === null ? 0 : threadSearchResultKeys.indexOf(searchHighlightKey),
    );
    const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
      setSearchHighlightKey(
        threadSearchResultKeys[
          typeof index === "function" ? index(activeSearchResultIndex) : index
        ] ?? null,
      );
    const moveSearchHighlight = (step: 1 | -1) => {
      const count = threadSearchResults.length;
      setActiveSearchResultIndex((activeSearchResultIndex + step + count) % count);
    };

    const orderedThreadKeysRef = useRef(orderedThreadKeys);
    // Read changing maps/sets through refs so streamed events preserve row callbacks.
    const threadByKeyRef = useRef(threadByKey);
    const settledThreadKeysRef = useRef(settledThreadKeys);
    const snoozedThreadKeysRef = useRef(snoozedThreadKeys);

    const jumpLabelByKey = (() => {
      const mapping = new Map<string, string>();
      for (const [index, threadKey] of orderedThreadKeys.entries()) {
        const jumpCommand = threadJumpCommandForIndex(index);
        if (!jumpCommand) break;
        const label = shortcutLabelForCommand(keybindings, jumpCommand);
        if (label) mapping.set(threadKey, label);
      }
      return mapping;
    })();

    const navigateToThread = (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    };

    const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      const landedBefore =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (landedBefore) return;

      try {
        await navigateToThread(threadRef);
        const landed =
          router.buildLocation({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }).pathname === router.state.location.pathname;
        if (!landed) clearPendingFileDrop(dropId);
      } catch {
        clearPendingFileDrop(dropId);
      }
    };

    const navigateToDraft = (draftId: DraftId) => {
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    };

    const clearThreadSearch = () => {
      setThreadSearchQuery("");
      setSearchHighlightKey(null);
    };
    const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      // A row listed for a message match opens find on it, as the palette does.
      const match = threadSearchMatchByKey.get(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      );
      const query = threadSearch.query;
      clearThreadSearch();
      navigateToThread(ref);
      if (match) openThreadFindOnQuery(scopedThreadKey(ref), findForMessageMatch(match, query));
    };
    const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSearchHighlight(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSearchHighlight(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    };

    const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      setRenamingThreadRef(threadRef);
      setRenamingTitle(title);
    };
    const cancelThreadRename = () => setRenamingThreadRef(null);
    const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
        const trimmed = title.trim();
        setRenamingThreadRef(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    };

    const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    };

    // Snapshot navigation before partition mutation; background parks use a null plan.
    const planForwardNavigation = (
      threadKey: string,
      coParkingKeys?: ReadonlySet<string>,
    ): (() => void) | null => {
      if (readRouteThreadKey(router) !== threadKey) return null;
      const shell = threadByKeyRef.current.get(threadKey);
      const orderedKeys = orderedThreadKeysRef.current;
      const settledKeys = settledThreadKeysRef.current;
      const snoozedKeys = snoozedThreadKeysRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null);
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () => void handleNewThread(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: "/" });
    };

    const attemptSettle = (
      threadRef: ScopedThreadRef,
      opts: { coSettlingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
        const result = await settleThread(threadRef);
        settlingThreadKeysRef.current.delete(threadKey);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to settle thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        if (
          shouldNavigateAfterThreadPark({
            threadKey,
            currentThreadKey: readRouteThreadKey(router),
            action: "settle",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        ) {
          navigateAfterSettle?.();
        }
      })();
    };
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this sidebar's settle handler in the module-level settleAndAdvance registry
    useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
    const settleThreads = (threadKeys: readonly string[]) => {
      const coSettlingKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread || thread.settledOverride === "settled") continue;
        attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
      }
    };
    const attemptUnsettle = (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsettleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    };
    const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsnoozeThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    };
    const restrictBelowPins: Modifier = (args) =>
      restrictBelowSidebarLabel(args, dragLabelOffsetRef.current);
    const dndModifiers = [
      restrictToVerticalAxis,
      restrictBelowPins,
      restrictToFirstScrollableAncestor,
    ];
    const attachListMotionRef = (node: HTMLUListElement) => {
      threadListRef.current = node;
      const motion = createSidebarListMotion(node);
      listMotionRef.current = motion;
      motion.update(false);
      return () => {
        // Search replaces this list while the Sidebar stays mounted, and a drag
        // whose rows are gone can never drop. The compiler memoizes this callback
        // with no deps (it reads only refs), so the cleanup runs only on unmount.
        dragSensorRef.current?.cancel();
        motion.dispose();
        if (listMotionRef.current === motion) listMotionRef.current = null;
        if (threadListRef.current === node) threadListRef.current = null;
      };
    };

    const attachTreeRef = (node: HTMLUListElement) => {
      const detachMotion = attachListMotionRef(node);
      const detachTree = attachSidebarTree(node);
      return () => {
        detachTree?.();
        detachMotion();
      };
    };

    const isContextDrag = dragState?.contextDrag === true || dragState?.activeSection === "working";
    const dragTargetSection = isContextDrag ? null : (dragState?.targetSection ?? null);
    const finishThreadDrag = (started: boolean) => {
      dragSensorRef.current = null;
      contextDragKeyRef.current = null;
      endThreadContextDrag();
      if (started) {
        listMotionRef.current?.release();
        setDragState(null);
      }
    };
    const attachDragSensor = (sensor: SidebarPointerSensor) => {
      dragSensorRef.current = sensor;
    };
    const cancelThreadDrag = () => {
      dragSensorRef.current?.cancel();
    };
    const contextDragThreads = (): ReadonlyArray<ScopedThreadRef> => {
      const key = contextDragKeyRef.current;
      if (key === null) return [];
      const selected = useThreadSelectionStore.getState().selectedThreadKeys;
      const keys = selected.has(key) ? [...selected] : [key];
      return keys.flatMap((candidate) => {
        const ref = parseScopedThreadKey(candidate);
        return ref ? [ref] : [];
      });
    };
    const pointerOutsideThreadList = (point: { x: number; y: number }) => {
      const bounds = threadListRef.current?.getBoundingClientRect();
      return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
    };
    const moveThreadContextDrag = (point: { x: number; y: number }) => {
      const contextDrag = pointerOutsideThreadList(point);
      setDragState((current) =>
        current === null || current.contextDrag === contextDrag
          ? current
          : { ...current, contextDrag },
      );
      if (!contextDrag) {
        endThreadContextDrag();
        return false;
      }
      const threads = contextDragThreads();
      const title =
        threadByKeyRef.current.get(contextDragKeyRef.current ?? "")?.title.trim() || "Thread";
      moveThreadContextDragGhost(point, { title, count: threads.length });
      return true;
    };
    const dropThreadContextDrag = (point: { x: number; y: number }) => {
      if (!pointerOutsideThreadList(point)) return false;
      dropThreadContext(point, contextDragThreads());
      return true;
    };
    // useSensor memoizes options identity; fresh options rebuild DndContext and every sortable row.
    const pointerSensorOptions = {
      distance: SIDEBAR_DRAG_DISTANCE,
      onAttach: attachDragSensor,
      onFinish: finishThreadDrag,
      onMove: moveThreadContextDrag,
      onDrop: dropThreadContextDrag,
    };
    const dndSensors = useSensors(useSensor(SidebarPointerSensor, pointerSensorOptions));

  return { threadSearchResults, threadSearchMatchByKey, activeSearchResultIndex, setActiveSearchResultIndex, orderedThreadKeysRef, threadByKeyRef, settledThreadKeysRef, snoozedThreadKeysRef, jumpLabelByKey, navigateToThread, handleThreadFileDrop, navigateToDraft, clearThreadSearch, selectThreadSearchResult, handleThreadSearchKeyDown, startThreadRename, cancelThreadRename, commitThreadRename, handleThreadClick, planForwardNavigation, attemptSettle, settleThreads, attemptUnsettle, attemptUnsnooze, dndModifiers, attachTreeRef, isContextDrag, dragTargetSection, cancelThreadDrag, dndSensors };
}
