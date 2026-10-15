export type WorkspaceTab = "threads" | "pullRequests" | "issues";
export type WorkspaceSearchMode = "resting" | "active" | "expanded";

export interface WorkspaceTabState {
  readonly query: string;
  readonly searchMode: WorkspaceSearchMode;
  readonly scrollOffset: number;
  readonly searchEntryOffset: number;
}

export interface WorkspaceTabsState {
  readonly selectedTab: WorkspaceTab;
  readonly selectionRevision: number;
  readonly tabs: Readonly<Record<WorkspaceTab, WorkspaceTabState>>;
}

function emptyTab(): WorkspaceTabState {
  return { query: "", searchMode: "resting", scrollOffset: 0, searchEntryOffset: 0 };
}

export function initialWorkspaceTabsState(): WorkspaceTabsState {
  return {
    selectedTab: "threads",
    selectionRevision: 0,
    tabs: { threads: emptyTab(), pullRequests: emptyTab(), issues: emptyTab() },
  };
}

export type WorkspaceTabsAction =
  | { readonly type: "select"; readonly tab: WorkspaceTab }
  | { readonly type: "search"; readonly tab?: WorkspaceTab }
  | { readonly type: "query"; readonly query: string; readonly tab?: WorkspaceTab }
  | { readonly type: "expand"; readonly tab?: WorkspaceTab }
  | { readonly type: "cancel"; readonly tab?: WorkspaceTab }
  | { readonly type: "scroll"; readonly tab: WorkspaceTab; readonly offset: number };

/** Each root retains its own search; leaving search restores the unfiltered list position. */
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

export const WORKSPACE_TAB_PRESENTATION = {
  threads: { title: "Threads", label: "Threads", icon: "text.bubble", search: "Search threads" },
  pullRequests: {
    title: "Pull requests",
    label: "PRs",
    icon: "arrow.triangle.pull",
    search: "Search pull requests",
  },
  issues: {
    title: "Issues",
    label: "Issues",
    icon: "circle.inset.filled",
    search: "Search issues",
  },
} as const;

export const WORKSPACE_TOOLBAR = { height: 48, expandedGap: 10, edge: 16, gap: 8 };
export const WORKSPACE_DOCK = { height: 48, tabsWidth: 252, gap: 12, bottomGap: 6 };

export function workspaceToolbarHeight(mode: WorkspaceSearchMode): number {
  return mode === "expanded"
    ? WORKSPACE_TOOLBAR.height * 2 + WORKSPACE_TOOLBAR.expandedGap
    : WORKSPACE_TOOLBAR.height;
}
