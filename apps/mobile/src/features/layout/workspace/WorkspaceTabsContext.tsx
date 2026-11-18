import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, use, useState, type Dispatch, type ReactNode } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import {
  isSharedSlotTab,
  sharedSlotAbsentee,
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  resolveSelectedNavigationTab,
} from "./navigation-tab-order";
import {
  initialWorkspaceTabsState,
  resolveWorkspaceTabOrder,
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
  /** Leaves search and returns the list to where it was when search began. */
  readonly cancelSearch: (tab: WorkspaceSearchTab) => void;
  /** Asks the tab's list to scroll to its top, as when its already selected tab is tapped again. */
  readonly requestScrollToTop: (tab: WorkspaceTab) => void;
  readonly onScrollToTopRequest: (tab: WorkspaceTab, listener: () => void) => () => void;
} | null>(null);

export function useWorkspaceTabs() {
  return use(WorkspaceTabsContext);
}

type MobilePreferencesResult = Atom.Type<typeof mobilePreferencesAtom>;

/** Moves the selection off a tab the user has hidden or that no longer exists. */
function resolveWorkspaceTabsSelection(
  state: WorkspaceTabsState,
  preferences: MobilePreferencesResult,
): WorkspaceTabsState {
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const order = resolveWorkspaceTabOrder(saved?.navigationTabOrder);
  const hidden = [
    ...(navigationCustomizationAvailable()
      ? resolveHiddenNavigationTabs(saved?.hiddenNavigationTabs)
      : []),
    sharedSlotAbsentee(state.selectedTab, saved?.sharedSlotTab),
  ];
  const selected = resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  return selected && selected !== state.selectedTab
    ? workspaceTabsReducer(state, { type: "select", tab: selected })
    : state;
}

// One model per provider. Handlers on frozen screens keep stale closures, so
// they read the current selection from the registry at call time.
function createWorkspaceTabsModel(selectedTab?: WorkspaceTab) {
  const stored = Atom.make(initialWorkspaceTabsState(selectedTab));
  const scrollOffsets: Record<WorkspaceSearchTab, number> = {
    threads: 0,
    pullRequests: 0,
    issues: 0,
    usage: 0,
    settings: 0,
  };
  const scrollToTopListeners = new Set<{ tab: WorkspaceTab; listener: () => void }>();
  return {
    stored,
    resolved: Atom.make((get) =>
      resolveWorkspaceTabsSelection(get(stored), get(mobilePreferencesAtom)),
    ),
    getScrollOffset: (tab: WorkspaceSearchTab) => scrollOffsets[tab],
    recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => {
      scrollOffsets[tab] = offset;
    },
    requestScrollToTop: (tab: WorkspaceTab) => {
      for (const entry of scrollToTopListeners) if (entry.tab === tab) entry.listener();
    },
    onScrollToTopRequest: (tab: WorkspaceTab, listener: () => void) => {
      const entry = { tab, listener };
      scrollToTopListeners.add(entry);
      return () => {
        scrollToTopListeners.delete(entry);
      };
    },
  };
}

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
  readonly initialTab?: WorkspaceTab;
}) {
  const registry = use(RegistryContext);
  const [model] = useState(() => createWorkspaceTabsModel(props.initialTab));
  const state = useAtomValue(model.resolved);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dispatch = (action: WorkspaceTabsAction) => {
    registry.set(model.stored, workspaceTabsReducer(registry.get(model.resolved), action));
    if (action.type === "select" && isSharedSlotTab(action.tab))
      savePreferences({ sharedSlotTab: action.tab });
  };
  const context = {
    state,
    dispatch,
    isTabActive: (tab: WorkspaceTab) => registry.get(model.resolved).selectedTab === tab,
    bottomClearance: 0,
    settingsOpen: props.settingsOpen ?? false,
    getScrollOffset: model.getScrollOffset,
    recordScrollOffset: model.recordScrollOffset,
    requestScrollToTop: model.requestScrollToTop,
    onScrollToTopRequest: model.onScrollToTopRequest,
    cancelSearch: (tab: WorkspaceSearchTab) => {
      model.recordScrollOffset(tab, registry.get(model.resolved).tabs[tab].searchEntryOffset);
      dispatch({ type: "cancel", tab });
    },
  };
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
