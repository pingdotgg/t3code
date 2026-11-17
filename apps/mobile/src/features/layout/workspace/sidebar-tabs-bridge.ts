import { useSyncExternalStore, type ContextType } from "react";

import type { WorkspaceTabsContext } from "./WorkspaceTabsContext";

export type SidebarTabs = NonNullable<ContextType<typeof WorkspaceTabsContext>>;
type WorkspaceTabs = SidebarTabs | null;

// Before iPadOS 26 the JS sidebar renders outside the navigator that provides the workspace
// tabs, so the navigator hands them over for the sidebar to draw the tab bar at its foot.
let current: WorkspaceTabs = null;
const listeners = new Set<() => void>();

export function publishSidebarTabs(tabs: WorkspaceTabs) {
  if (current === tabs) return;
  current = tabs;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarTabs() {
  return useSyncExternalStore(subscribe, () => current);
}
