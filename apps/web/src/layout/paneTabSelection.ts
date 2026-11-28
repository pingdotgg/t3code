/** Non-persisted per-pane tab multi-selection; kept outside `useLayoutStore` so selection never notifies layout subscribers. */
import { create } from "zustand";

import { selectTabRange } from "../lib/tabSelection";
import { isMacPlatform } from "../lib/utils";
import { findLayoutPane, findLayoutTab, selectFocusedPane } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

const EMPTY_IDS: ReadonlySet<string> = new Set();

interface PaneTabSelectionState {
  readonly paneId: string | null;
  readonly anchorId: string | null;
  /** Tabs selected by Cmd/Ctrl-clicks prior to a Shift-range extension. */
  readonly baseIds: ReadonlySet<string>;
  /** Currently selected tab ids in `paneId`; always empty unless size >= 2. */
  readonly selectedIds: ReadonlySet<string>;
}

const EMPTY_SELECTION: PaneTabSelectionState = {
  paneId: null,
  anchorId: null,
  baseIds: EMPTY_IDS,
  selectedIds: EMPTY_IDS,
};

const usePaneTabSelectionStore = create<PaneTabSelectionState>()(() => EMPTY_SELECTION);

export function subscribePaneTabSelection(listener: () => void): () => void {
  return usePaneTabSelectionStore.subscribe(listener);
}

/** O(1) no-op when nothing is selected, keeping plain tab clicks allocation-free. */
export function clearPaneTabSelection(): void {
  if (usePaneTabSelectionStore.getState().paneId === null) return;
  usePaneTabSelectionStore.setState(EMPTY_SELECTION);
}

/** Per-tab boolean selector: re-renders a tab only when its own selected flag flips. */
export function useIsLayoutTabSelected(paneId: string | null, tabId: string | null): boolean {
  return usePaneTabSelectionStore(
    (state) =>
      paneId !== null && tabId !== null && state.paneId === paneId && state.selectedIds.has(tabId),
  );
}

export function isLayoutTabSelected(tabId: string): boolean {
  const { paneId, selectedIds } = usePaneTabSelectionStore.getState();
  return paneId !== null && selectedIds.has(tabId);
}

export function hasPaneTabSelection(paneId?: string | null): boolean {
  const state = usePaneTabSelectionStore.getState();
  if (state.paneId === null || state.selectedIds.size < 2) return false;
  return paneId === undefined ? true : state.paneId === paneId;
}

/** Selected tab ids in `paneId` (or the currently selected pane) in pane tab order. */
export function readSelectedLayoutTabIds(paneId?: string | null): readonly string[] {
  const state = usePaneTabSelectionStore.getState();
  if (state.paneId === null || state.selectedIds.size < 2) return [];
  if (paneId !== undefined && paneId !== null && state.paneId !== paneId) return [];
  const pane = findLayoutPane(useLayoutStore.getState().layout, state.paneId)?.pane;
  if (!pane) return [];
  return pane.tabs.filter((tab) => state.selectedIds.has(tab.id)).map((tab) => tab.id);
}

export function isTabToggleModifier(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): boolean {
  if (event.altKey) return false;
  return typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

function focusPaneForSelection(paneId: string): void {
  const store = useLayoutStore.getState();
  if (selectFocusedPane(store.layout)?.id !== paneId) {
    store.focusPane(paneId);
  }
}

/** Shift-click range selection anchored at the pane's active tab (or last toggle anchor). */
function selectPaneTabRange(tabId: string): void {
  const location = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === tabId);
  if (!location) return;
  const { pane } = location;
  focusPaneForSelection(pane.id);
  const current = usePaneTabSelectionStore.getState();
  const samePane = current.paneId === pane.id;
  const anchorId = (samePane ? current.anchorId : null) ?? pane.activeTabId;
  if (anchorId === null) return;
  const baseIds = samePane ? current.baseIds : EMPTY_IDS;
  const range = selectTabRange(pane.tabs, (tab) => tab.id, anchorId, tabId);
  if (range.length === 0) return;
  const selectedIds = new Set<string>(baseIds);
  for (const tab of range) selectedIds.add(tab.id);
  if (selectedIds.size < 2) {
    clearPaneTabSelection();
    return;
  }
  usePaneTabSelectionStore.setState({
    paneId: pane.id,
    anchorId,
    baseIds,
    selectedIds,
  });
}

/** Cmd/Ctrl-click toggle of one tab within its pane. */
function togglePaneTabSelection(tabId: string): void {
  const location = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === tabId);
  if (!location) return;
  const { pane } = location;
  focusPaneForSelection(pane.id);
  const current = usePaneTabSelectionStore.getState();
  const samePane = current.paneId === pane.id;
  const next = new Set<string>(
    samePane ? current.selectedIds : pane.activeTabId !== null ? [pane.activeTabId] : [],
  );
  let anchorId: string | null = samePane ? current.anchorId : pane.activeTabId;
  if (next.has(tabId)) {
    next.delete(tabId);
    if (anchorId === tabId) {
      anchorId =
        pane.activeTabId !== null && next.has(pane.activeTabId)
          ? pane.activeTabId
          : (pane.tabs.find((tab) => next.has(tab.id))?.id ?? null);
    }
  } else {
    next.add(tabId);
    anchorId = tabId;
  }
  if (next.size < 2) {
    clearPaneTabSelection();
    return;
  }
  usePaneTabSelectionStore.setState({
    paneId: pane.id,
    anchorId,
    baseIds: next,
    selectedIds: next,
  });
}

/**
 * Handle a click on a pane tab (active or inactive). Returns true when the
 * click was consumed by multi-selection or by clearing an existing selection
 * on the active tab so callers skip opening a title menu or switching tabs.
 */
export function handlePaneTabClick(
  event: {
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    preventDefault: () => void;
  },
  tabId: string,
  options: { readonly active?: boolean } = {},
): boolean {
  if (event.shiftKey) {
    event.preventDefault();
    selectPaneTabRange(tabId);
    return true;
  }
  if (isTabToggleModifier(event)) {
    event.preventDefault();
    togglePaneTabSelection(tabId);
    return true;
  }
  if (usePaneTabSelectionStore.getState().paneId !== null) {
    clearPaneTabSelection();
    return options.active === true;
  }
  return false;
}

// Clear selection when focus leaves its pane, its active tab changes, a selected
// tab leaves the pane, or the workspace overview opens. Fast no-op when empty.
useLayoutStore.subscribe((state, previous) => {
  const selection = usePaneTabSelectionStore.getState();
  if (selection.paneId === null) return;
  if (state.overviewOpen && !previous.overviewOpen) {
    clearPaneTabSelection();
    return;
  }
  if (state.layout === previous.layout) return;
  if (state.layout.focusedWorkspaceId !== previous.layout.focusedWorkspaceId) {
    clearPaneTabSelection();
    return;
  }
  const focusedPane = selectFocusedPane(state.layout);
  if (!focusedPane || focusedPane.id !== selection.paneId) {
    clearPaneTabSelection();
    return;
  }
  const previousPane = findLayoutPane(previous.layout, selection.paneId)?.pane ?? null;
  if (previousPane && previousPane.activeTabId !== focusedPane.activeTabId) {
    clearPaneTabSelection();
    return;
  }
  const currentTabIds = new Set(focusedPane.tabs.map((tab) => tab.id));
  for (const id of selection.selectedIds) {
    if (!currentTabIds.has(id)) {
      clearPaneTabSelection();
      return;
    }
  }
});
