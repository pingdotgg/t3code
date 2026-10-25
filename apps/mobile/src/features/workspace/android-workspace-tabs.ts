import type { NavigationState } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import {
  isSettingsRoute,
  settingsNavigationState,
  settingsOpenIn,
} from "../settings/settings-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Settings joins the two list tabs as a top-level Android destination. */
export type AndroidWorkspaceNavigationTab = WorkspaceTab | "settings";

const WORKSPACE_ROUTES = new Set(["Home", "Thread", "PullRequest"]);

/** The Settings tab resets over Home alone so stale chat and PR history is dropped. */
export function androidWorkspaceTabNavigationState(
  state: NavigationState,
  tab: AndroidWorkspaceNavigationTab,
) {
  const home = androidWorkspaceNavigationState(state);
  return tab === "settings" ? settingsNavigationState(home, undefined) : home;
}

/** Settings stays selected while one of its pages is the topmost workspace route. */
export function androidWorkspaceSettingsOpen(state: NavigationState): boolean {
  return settingsOpenIn(
    state.routes
      .slice(0, state.index + 1)
      .filter((route) => WORKSPACE_ROUTES.has(route.name) || isSettingsRoute(route.name)),
  );
}

export function androidWorkspaceTabFromNavigationState(
  state: NavigationState,
  selected: AndroidWorkspaceNavigationTab,
): AndroidWorkspaceNavigationTab {
  if (androidWorkspaceSettingsOpen(state)) return "settings";
  return selected === "settings" ? "threads" : selected;
}
