import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";
import { useSidebarScopeState } from "./useSidebarScopeState";
import { useSidebarSearchState } from "./useSidebarSearchState";

import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
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
import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isElectron } from "../../env";
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
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
export function useSidebarRouteState(props: SidebarProps, params: {
  s1: ReturnType<typeof useSidebarLookupState>,
  s2: ReturnType<typeof useSidebarScopeState>,
  s3: ReturnType<typeof useSidebarSearchState>,
  }) {
  const { s1, s2, s3 } = params;
  const { routeThreadRef, keybindings, routeRowThreadKey, shortcutModifiers, terminalFocused, legacySidebarEnabled, scopeGroups, projectGroups, isMobile, setOpenMobile, newThreadContext, handleNewThread } = s1;
  const { threadByKey, orderedThreadKeys } = s2;
  const { navigateToThread } = s3;

    const routeTerminalOpen = useTerminalUiStateStore((state) =>
      routeThreadRef
        ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
        : false,
    );
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for thread navigation shortcuts using the current thread list
    useEffect(() => {
      const onWindowKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
          return;
        }
        const command = resolveShortcutCommand(event, keybindings, {
          platform: navigator.platform,
          context: {
            terminalFocus: isTerminalFocused(),
            terminalOpen: routeTerminalOpen,
            modelPickerOpen: isModelPickerOpen(),
            isWeb: !isElectron,
            isDesktop: isElectron,
          },
        });
        const navigateToThreadKey = (targetThreadKey: string | null) => {
          if (!targetThreadKey) return false;
          const targetThread = threadByKey.get(targetThreadKey);
          if (!targetThread) return false;
          event.preventDefault();
          event.stopPropagation();
          navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
          return true;
        };
        const traversalDirection = threadTraversalDirectionFromCommand(command);
        if (traversalDirection !== null) {
          navigateToThreadKey(
            resolveAdjacentThreadId({
              threadIds: orderedThreadKeys,
              currentThreadId: routeRowThreadKey,
              direction: traversalDirection,
            }),
          );
          return;
        }
        const jumpIndex = threadJumpIndexFromCommand(command ?? "");
        if (jumpIndex === null) return;
        navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
      };
      window.addEventListener("keydown", onWindowKeyDown);
      return () => window.removeEventListener("keydown", onWindowKeyDown);
    }, [
      keybindings,
      navigateToThread,
      orderedThreadKeys,
      routeRowThreadKey,
      routeTerminalOpen,
      threadByKey,
    ]);

    const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
      shortcutModifiers,
      keybindings,
      {
        platform: navigator.platform,
        context: {
          terminalFocus: terminalFocused,
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      },
    );
    const showJumpHints = useThreadJumpHintsVisible(shouldShowJumpHintsNow);

    const handleNewThreadClick = (event?: ReactMouseEvent) => {
      if (
        legacySidebarEnabled ||
        shouldCreateNewThreadInCurrentProject(
          event?.shiftKey ?? false,
          scopeGroups.length,
          projectGroups.length,
        )
      ) {
        if (isMobile) setOpenMobile(false);
        // With no current or open project, such as when every project is archived, pick one.
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread,
        }).then((started) => {
          if (!started) openCommandPalette({ open: "new-thread-in" });
        });
        return;
      }
      if (isMobile) setOpenMobile(false);
      openCommandPalette({ open: "new-thread-in" });
    };

    const newThreadShortcutLabel =
      shortcutLabelForCommand(keybindings, "chat.new") ??
      (shouldCreateNewThreadInCurrentProject(false, scopeGroups.length, projectGroups.length)
        ? shortcutLabelForCommand(keybindings, "chat.newLocal")
        : undefined);
    const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");

  return { showJumpHints, handleNewThreadClick, newThreadShortcutLabel, newThreadInProjectShortcutLabel };
}
