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
export type WorkspaceSearchMode = "resting" | "active" | "expanded";

/** Settings, Chats and pull requests pair a list with a detail column; Usage is one page. */
export function workspaceUsesColumns(tab: WorkspaceTab, settingsOpen = false) {
  return settingsOpen || tab === "threads" || tab === "pullRequests";
}

export interface WorkspaceTabState {
  readonly query: string;
  readonly searchMode: WorkspaceSearchMode;
  readonly scrollOffset: number;
  readonly searchEntryOffset: number;
  /** Counts requests to focus the search field; the header focuses once per request. */
  readonly searchFocusRequest: number;
}

export interface WorkspaceTabsState {
  readonly selectedTab: WorkspaceTab;
  readonly selectionRevision: number;
  readonly tabs: Readonly<Record<WorkspaceTab, WorkspaceTabState>>;
}

function emptyTab(): WorkspaceTabState {
  return {
    query: "",
    searchMode: "resting",
    scrollOffset: 0,
    searchEntryOffset: 0,
    searchFocusRequest: 0,
  };
}

export function initialWorkspaceTabsState(): WorkspaceTabsState {
  return {
    selectedTab: "threads",
    selectionRevision: 0,
    tabs: {
      threads: emptyTab(),
      pullRequests: emptyTab(),
      usage: emptyTab(),
    },
  };
}

export type WorkspaceTabsAction =
  | { readonly type: "select"; readonly tab: WorkspaceTab }
  | { readonly type: "search"; readonly tab?: WorkspaceTab }
  | { readonly type: "query"; readonly query: string; readonly tab?: WorkspaceTab }
  | { readonly type: "expand"; readonly tab?: WorkspaceTab }
  | { readonly type: "cancel"; readonly tab?: WorkspaceTab }
  | { readonly type: "scroll"; readonly tab: WorkspaceTab; readonly offset: number };

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
  if (tab !== "threads" && tab !== "pullRequests") return state;
  const current = state.tabs[tab];
  let next: WorkspaceTabState;
  switch (action.type) {
    case "search":
      next = {
        ...current,
        searchMode: "active",
        searchEntryOffset:
          current.searchMode === "resting" ? current.scrollOffset : current.searchEntryOffset,
        searchFocusRequest: current.searchFocusRequest + 1,
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
