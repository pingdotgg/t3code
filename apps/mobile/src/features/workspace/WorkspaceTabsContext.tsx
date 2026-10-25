import { resolveSelectedNavigationTab } from "./navigation-tab-order";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  type WorkspaceSearchTab,
  type WorkspaceTab,
  type WorkspaceTabsAction,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

export const WorkspaceTabsContext = createContext<{
  readonly state: WorkspaceTabsState;
  readonly dispatch: Dispatch<WorkspaceTabsAction>;
  readonly isTabActive: (tab: WorkspaceTab) => boolean;
  readonly bottomClearance: number;
  readonly settingsOpen: boolean;
  readonly getScrollOffset: (tab: WorkspaceSearchTab) => number;
  readonly recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => void;
} | null>(null);

export function useWorkspaceTabs() {
  return use(WorkspaceTabsContext);
}

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
}) {
  const [state, dispatch] = useReducer(workspaceTabsReducer, undefined, initialWorkspaceTabsState);
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const selected = resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  if (selected && selected !== state.selectedTab) dispatch({ type: "select", tab: selected });
  const activeTab = useRef(state.selectedTab);
  useLayoutEffect(() => {
    activeTab.current = state.selectedTab;
  }, [state.selectedTab]);
  const isTabActive = useCallback((tab: WorkspaceTab) => activeTab.current === tab, []);
  const scrollOffsets = useRef({ threads: 0, pullRequests: 0, usage: 0, settings: 0 });
  const getScrollOffset = useCallback((tab: WorkspaceSearchTab) => scrollOffsets.current[tab], []);
  const recordScrollOffset = useCallback((tab: WorkspaceSearchTab, offset: number) => {
    scrollOffsets.current[tab] = offset;
  }, []);
  const context = useMemo(
    () => ({
      state,
      dispatch,
      isTabActive,
      bottomClearance: 0,
      settingsOpen: props.settingsOpen ?? false,
      getScrollOffset,
      recordScrollOffset,
    }),
    [state, isTabActive, getScrollOffset, recordScrollOffset, props.settingsOpen],
  );
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
