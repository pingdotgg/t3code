import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { useShallow } from "zustand/react/shallow";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveAdjacentThreadId,
  shouldClearThreadSelectionOnMouseDown,
  useThreadJumpHintVisibility,
} from "../Sidebar.logic";
import {
  createSidebarActiveRouteProjectKeySelectorByRef,
  createSidebarSortedThreadKeysByLogicalProjectSelector,
} from "./sidebarSelectors";
import type { LogicalProjectKey } from "../../logicalProject";
import {
  setSidebarKeyboardState,
  useSidebarExpandedThreadListsByProject,
} from "./sidebarViewStore";
import { useServerKeybindings } from "../../rpc/serverState";
import { useStore } from "../../store";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { THREAD_PREVIEW_LIMIT } from "./sidebarConstants";

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();

function readSidebarShortcutContext(routeThreadRef: ScopedThreadRef | null) {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: routeThreadRef
      ? selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadKey,
          routeThreadRef,
        ).terminalOpen
      : false,
  };
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

function useSidebarKeyboardController(input: {
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  sortedProjectKeys: readonly LogicalProjectKey[];
  expandedThreadListsByProject: ReadonlySet<LogicalProjectKey>;
  routeThreadRef: ScopedThreadRef | null;
  routeThreadKey: string | null;
  platform: string;
  keybindings: ReturnType<typeof useServerKeybindings>;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  threadSortOrder: SidebarThreadSortOrder;
}) {
  const {
    physicalToLogicalKey,
    sortedProjectKeys,
    expandedThreadListsByProject,
    routeThreadRef,
    routeThreadKey,
    platform,
    keybindings,
    navigateToThread,
    threadSortOrder,
  } = input;
  const projectExpandedStates = useUiStateStore(
    useShallow((store) =>
      sortedProjectKeys.map((projectKey) => store.projectExpandedById[projectKey] ?? true),
    ),
  );
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const sortedThreadKeysByLogicalProject = useStore(
    useMemo(
      () =>
        createSidebarSortedThreadKeysByLogicalProjectSelector({
          physicalToLogicalKey,
          threadSortOrder,
        }),
      [physicalToLogicalKey, threadSortOrder],
    ),
  );
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjectKeys.flatMap((projectKey, index) => {
        const projectThreadKeys = sortedThreadKeysByLogicalProject.get(projectKey) ?? [];
        const projectExpanded = projectExpandedStates[index] ?? true;
        const activeThreadKey = routeThreadKey ?? undefined;
        const pinnedCollapsedThread =
          !projectExpanded && activeThreadKey
            ? (projectThreadKeys.find((threadKey) => threadKey === activeThreadKey) ?? null)
            : null;
        const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
        if (!shouldShowThreadPanel) {
          return [];
        }

        const isThreadListExpanded = expandedThreadListsByProject.has(projectKey);
        const hasOverflowingThreads = projectThreadKeys.length > THREAD_PREVIEW_LIMIT;
        const previewThreadKeys =
          isThreadListExpanded || !hasOverflowingThreads
            ? projectThreadKeys
            : projectThreadKeys.slice(0, THREAD_PREVIEW_LIMIT);
        return pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreadKeys;
      }),
    [
      expandedThreadListsByProject,
      projectExpandedStates,
      routeThreadKey,
      sortedProjectKeys,
      sortedThreadKeysByLogicalProject,
    ],
  );
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => readSidebarShortcutContext(routeThreadRef),
    [routeThreadRef],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      showThreadJumpHints
        ? buildThreadJumpLabelMap({
            keybindings,
            platform,
            terminalOpen: getCurrentSidebarShortcutContext().terminalOpen,
            threadJumpCommandByKey,
          })
        : EMPTY_THREAD_JUMP_LABELS,
    [
      getCurrentSidebarShortcutContext,
      keybindings,
      platform,
      showThreadJumpHints,
      threadJumpCommandByKey,
    ],
  );
  const threadJumpLabelsRef = useRef<ReadonlyMap<string, string>>(threadJumpLabelByKey);
  threadJumpLabelsRef.current = threadJumpLabelByKey;
  const showThreadJumpHintsRef = useRef(showThreadJumpHints);
  showThreadJumpHintsRef.current = showThreadJumpHints;
  const latestKeyboardStateRef = useRef({
    keybindings,
    navigateToThread,
    platform,
    routeThreadKey,
    routeThreadRef,
    threadJumpThreadKeys,
    visibleSidebarThreadKeys,
  });
  latestKeyboardStateRef.current = {
    keybindings,
    navigateToThread,
    platform,
    routeThreadKey,
    routeThreadRef,
    threadJumpThreadKeys,
    visibleSidebarThreadKeys,
  };
  const updateThreadJumpHintsVisibilityRef = useRef(updateThreadJumpHintsVisibility);
  updateThreadJumpHintsVisibilityRef.current = updateThreadJumpHintsVisibility;

  useEffect(() => {
    const clearThreadJumpHints = () => {
      updateThreadJumpHintsVisibilityRef.current(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: globalThis.KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;
    const getCurrentSidebarShortcutContext = () =>
      readSidebarShortcutContext(latestKeyboardStateRef.current.routeThreadRef);

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }

      const {
        keybindings,
        navigateToThread,
        platform,
        routeThreadKey,
        threadJumpThreadKeys,
        visibleSidebarThreadKeys,
      } = latestKeyboardStateRef.current;
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        if (
          showThreadJumpHintsRef.current ||
          threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
        ) {
          clearThreadJumpHints();
        }
      } else {
        updateThreadJumpHintsVisibilityRef.current(true);
      }

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: visibleSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = parseScopedThreadKey(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(targetThread);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = parseScopedThreadKey(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThread);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }

      const { keybindings, platform } = latestKeyboardStateRef.current;
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      updateThreadJumpHintsVisibilityRef.current(true);
    };

    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  return threadJumpLabelByKey;
}

export const SidebarSelectionController = memo(function SidebarSelectionController() {
  const selectedThreadCount = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadCountRef = useRef(selectedThreadCount);
  selectedThreadCountRef.current = selectedThreadCount;
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadCountRef.current === 0) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) {
        return;
      }
      clearSelectionRef.current();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  return null;
});

export const SidebarKeyboardController = memo(function SidebarKeyboardController(props: {
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  sortedProjectKeys: readonly LogicalProjectKey[];
  sidebarThreadSortOrder: SidebarThreadSortOrder;
}) {
  const { navigateToThread, physicalToLogicalKey, sortedProjectKeys, sidebarThreadSortOrder } =
    props;
  const expandedThreadListsByProject = useSidebarExpandedThreadListsByProject();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const activeRouteProjectKey = useStore(
    useMemo(
      () => createSidebarActiveRouteProjectKeySelectorByRef(routeThreadRef, physicalToLogicalKey),
      [physicalToLogicalKey, routeThreadRef],
    ),
  );
  const keybindings = useServerKeybindings();
  const platform = navigator.platform;
  const threadJumpLabelByKey = useSidebarKeyboardController({
    physicalToLogicalKey,
    sortedProjectKeys,
    expandedThreadListsByProject,
    routeThreadRef,
    routeThreadKey,
    platform,
    keybindings,
    navigateToThread,
    threadSortOrder: sidebarThreadSortOrder,
  });

  useEffect(() => {
    setSidebarKeyboardState({
      activeRouteProjectKey,
      activeRouteThreadKey: routeThreadKey,
      threadJumpLabelByKey,
    });
  }, [activeRouteProjectKey, routeThreadKey, threadJumpLabelByKey]);

  return null;
});
