import type { NavigationState } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Settings joins the two list tabs as a top-level Android destination. */
export type AndroidWorkspaceNavigationTab = WorkspaceTab | "settings";

const WORKSPACE_ROUTES = new Set(["Home", "Thread", "PullRequest", "SettingsSheet"]);

/**
 * The Settings tab reuses the settings navigator, reset over Home alone so stale chat and
 * PR history is dropped while nested settings pages keep an ordinary Back.
 */
export function androidWorkspaceTabNavigationState(
  state: NavigationState,
  tab: AndroidWorkspaceNavigationTab,
) {
  const home = androidWorkspaceNavigationState(state);
  if (tab !== "settings") return home;
  return {
    ...home,
    index: 1,
    routes: [
      ...home.routes,
      {
        name: "SettingsSheet",
        params: { screen: "SettingsContent", params: { screen: "Settings" } },
      },
    ],
  };
}

/** Settings stays selected while its navigator is the topmost workspace route. */
export function androidWorkspaceSettingsOpen(state: NavigationState): boolean {
  const top = state.routes
    .slice(0, state.index + 1)
    .findLast((route) => WORKSPACE_ROUTES.has(route.name));
  return top?.name === "SettingsSheet";
}

export function androidWorkspaceTabFromNavigationState(
  state: NavigationState,
  selected: AndroidWorkspaceNavigationTab,
): AndroidWorkspaceNavigationTab {
  if (androidWorkspaceSettingsOpen(state)) return "settings";
  return selected === "settings" ? "threads" : selected;
}
