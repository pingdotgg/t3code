import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";

import { mobilePreferencesAtom } from "../../../state/preferences";
import {
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  resolveSelectedNavigationTab,
} from "./navigation-tab-order";
import {
  initialWorkspaceTabsState,
  resolveWorkspaceTabOrder,
  workspaceDetailTab,
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

type MobilePreferencesResult = Atom.Type<typeof mobilePreferencesAtom>;

/** Moves the selection off a tab the user has hidden or that no longer exists. */
function resolveWorkspaceTabsSelection(
  state: WorkspaceTabsState,
  preferences: MobilePreferencesResult,
): WorkspaceTabsState {
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const order = resolveWorkspaceTabOrder(saved?.navigationTabOrder);
  const hidden = navigationCustomizationAvailable()
    ? resolveHiddenNavigationTabs(saved?.hiddenNavigationTabs)
    : [];
  const selected = resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  return selected && selected !== state.selectedTab
    ? workspaceTabsReducer(state, { type: "select", tab: selected })
    : state;
}

// One model per provider. Handlers on frozen screens keep stale closures, so
// they read the current selection from the registry at call time.
function createWorkspaceTabsModel() {
  const stored = Atom.make(initialWorkspaceTabsState());
  const scrollOffsets: Record<WorkspaceSearchTab, number> = {
    threads: 0,
    pullRequests: 0,
    usage: 0,
    settings: 0,
  };
  return {
    stored,
    resolved: Atom.make((get) =>
      resolveWorkspaceTabsSelection(get(stored), get(mobilePreferencesAtom)),
    ),
    getScrollOffset: (tab: WorkspaceSearchTab) => scrollOffsets[tab],
    recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => {
      scrollOffsets[tab] = offset;
    },
  };
}

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
  /** The root stack's routes up to the focused one. */
  readonly routes?: readonly { readonly name: string; readonly key: string }[];
}) {
  const registry = use(RegistryContext);
  const [model] = useState(createWorkspaceTabsModel);
  const stored = useAtomValue(model.resolved);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const detailKey = props.routes?.[1]?.key;
  const detailTab = workspaceDetailTab(props.routes ?? []);
  // A link commits its page with no row handler; the tab must match in that render, or a
  // retained native slot freezes the page under the old tab.
  const linked =
    detailTab &&
    resolveWorkspaceTabsSelection(
      workspaceTabsReducer(stored, { type: "select", tab: detailTab }),
      preferences,
    );
  const state = linked && linked.selectedTab !== stored.selectedTab ? linked : stored;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Persists a linked page's tab so it stays selected after Back.
  useLayoutEffect(() => {
    if (detailKey === undefined || !detailTab) return;
    registry.set(
      model.stored,
      workspaceTabsReducer(registry.get(model.resolved), { type: "select", tab: detailTab }),
    );
  }, [detailKey, detailTab, model, registry]);
  const context = {
    state,
    dispatch: (action: WorkspaceTabsAction) =>
      registry.set(model.stored, workspaceTabsReducer(registry.get(model.resolved), action)),
    // Until the effect above persists this render's tab, the registry still holds `stored`.
    isTabActive: (tab: WorkspaceTab) => {
      const live = registry.get(model.resolved);
      return (live === stored ? state : live).selectedTab === tab;
    },
    bottomClearance: 0,
    settingsOpen: props.settingsOpen ?? false,
    getScrollOffset: model.getScrollOffset,
    recordScrollOffset: model.recordScrollOffset,
  };
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
