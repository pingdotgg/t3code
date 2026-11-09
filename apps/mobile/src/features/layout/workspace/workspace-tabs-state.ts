import {
  NAVIGATION_TAB_ORDER,
  navigationCustomizationAvailable,
  resolveNavigationTabOrder,
  type NavigationTab,
} from "./navigation-tab-order";

export function resolveWorkspaceTabOrder(saved: readonly unknown[] | undefined) {
  return navigationCustomizationAvailable()
    ? resolveNavigationTabOrder(saved)
    : NAVIGATION_TAB_ORDER;
}

export type WorkspaceTab = NavigationTab;
/** Lists with their own search: the searchable tabs and the Settings list. */
export type WorkspaceSearchTab = WorkspaceTab | "settings";
export type WorkspaceSearchMode = "resting" | "active" | "expanded";

/** Native Usage is one page; the legacy workspace keeps its sidebar for every tab.
 *
 * 原生分栏的用量为单页，兼容工作区的每个标签均保留侧栏。
 */
export function workspaceUsesColumns(
  tab: WorkspaceTab,
  settingsOpen = false,
  nativeColumns = true,
  splitView = true,
) {
  // Legacy iPad tabs retain their sidebar; full-page Settings and Usage stranded its navigation.
  //
  // 旧版 iPad 各标签保留侧栏，避免设置和用量铺满页面后导航仍滞留在左下角。
  return settingsOpen
    ? nativeColumns || splitView
    : (!nativeColumns && splitView) || tab === "threads" || tab === "pullRequests";
}

export interface WorkspaceTabState {
  readonly query: string;
  readonly searchMode: WorkspaceSearchMode;
  readonly scrollOffset: number;
  readonly searchEntryOffset: number;
}

export interface WorkspaceTabsState {
  readonly selectedTab: WorkspaceTab;
  readonly selectionRevision: number;
  readonly tabs: Readonly<Record<WorkspaceSearchTab, WorkspaceTabState>>;
}

function emptyTab(): WorkspaceTabState {
  return { query: "", searchMode: "resting", scrollOffset: 0, searchEntryOffset: 0 };
}

export function initialWorkspaceTabsState(): WorkspaceTabsState {
  return {
    selectedTab: "threads",
    selectionRevision: 0,
    tabs: {
      threads: emptyTab(),
      pullRequests: emptyTab(),
      usage: emptyTab(),
      settings: emptyTab(),
    },
  };
}

export type WorkspaceTabsAction =
  | { readonly type: "select"; readonly tab: WorkspaceTab }
  | { readonly type: "search"; readonly tab?: WorkspaceSearchTab }
  | { readonly type: "query"; readonly query: string; readonly tab?: WorkspaceSearchTab }
  | { readonly type: "expand"; readonly tab?: WorkspaceSearchTab }
  | { readonly type: "cancel"; readonly tab?: WorkspaceSearchTab }
  | { readonly type: "scroll"; readonly tab: WorkspaceSearchTab; readonly offset: number };

export function workspaceTabsReducer(
  state: WorkspaceTabsState,
  action: WorkspaceTabsAction,
): WorkspaceTabsState {
  if (action.type === "select")
    return action.tab === state.selectedTab
      ? state
      : {
          ...state,
          selectedTab: action.tab,
          selectionRevision: state.selectionRevision + 1,
        };
  const tab = action.tab ?? state.selectedTab;
  if (tab !== "threads" && tab !== "pullRequests" && tab !== "settings") return state;
  const current = state.tabs[tab];
  let next: WorkspaceTabState;
  switch (action.type) {
    case "search":
      next = {
        ...current,
        searchMode: "active",
        searchEntryOffset:
          current.searchMode === "resting" ? current.scrollOffset : current.searchEntryOffset,
      };
      break;
    case "query":
      next = { ...current, query: action.query };
      break;
    case "expand":
      if (current.searchMode === "resting") return state;
      next = { ...current, searchMode: "expanded" };
      break;
    case "cancel":
      next = {
        ...current,
        query: "",
        searchMode: "resting",
        scrollOffset: current.searchEntryOffset,
      };
      break;
    case "scroll":
      if (current.scrollOffset === action.offset) return state;
      next = { ...current, scrollOffset: action.offset };
      break;
  }
  return { ...state, tabs: { ...state.tabs, [tab]: next } };
}

/**
 * iOS 27's integrated search X closes the field with only a blur, leaving `expanded`.
 * An empty one has nothing to restore, except where the caller keeps it open (the Duo).
 */
export function shouldRestoreNativeSearch(tab: WorkspaceTabState, keepsEmptySearchOpen: boolean) {
  if (tab.searchMode === "resting") return false;
  return tab.searchMode === "active" || tab.query !== "" || keepsEmptySearchOpen;
}

export const WORKSPACE_TOOLBAR = { height: 48, expandedGap: 10, edge: 16, gap: 8 };
export const WORKSPACE_DOCK = { height: 48, tabsWidth: 176, gap: 12, bottomGap: 6 };

export function workspaceDockBottomClearance(input: {
  readonly bottomInset: number;
  readonly keyboardHeight: number;
}) {
  return 64 + Math.max(input.bottomInset, input.keyboardHeight) + 16;
}

export function workspaceSearchBottomClearance(input: {
  readonly bottomInset: number;
  readonly bottomBarInset?: number;
  readonly keyboardHeight: number;
}) {
  const bottom = input.bottomBarInset ?? Math.max(input.bottomInset, 12);
  // AboveKeyboard lifts the field to an 8-point gap above the keyboard.
  return (
    Math.max(bottom, input.keyboardHeight > 0 ? input.keyboardHeight + 8 : 0) +
    WORKSPACE_TOOLBAR.height +
    16
  );
}

export function workspaceToolbarHeight(mode: WorkspaceSearchMode): number {
  return mode === "expanded"
    ? WORKSPACE_TOOLBAR.height * 2 + WORKSPACE_TOOLBAR.expandedGap
    : WORKSPACE_TOOLBAR.height;
}

export const NATIVE_WORKSPACE_TAB_SLOTS = [
  "first",
  "second",
  "third",
  "fourth",
  "settings",
] as const;

export function workspaceTabForNativeSlot(order: readonly WorkspaceTab[], slot: string) {
  if (slot === "settings") return "settings";
  const index = NATIVE_WORKSPACE_TAB_SLOTS.findIndex((candidate) => candidate === slot);
  return order[index] ?? null;
}
