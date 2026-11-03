import type { NavigationState } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import {
  isSettingsRoute,
  settingsNavigationState,
  settingsOpenIn,
} from "../settings/settings-navigation";
import type { WorkspaceTab } from "./workspace-tabs-state";
import { rememberedSettingsPage, workspaceSelectionsIn } from "./workspace-tab-navigation";

/** Settings joins the two list tabs as a top-level Android destination. */
export type AndroidWorkspaceNavigationTab = WorkspaceTab | "settings";

const WORKSPACE_ROUTES = new Set(["Home", "Thread", "PullRequest"]);

/** The Settings tab resets over Home alone so stale chat and PR history is dropped. */
export function androidWorkspaceTabNavigationState(
  state: NavigationState,
  tab: AndroidWorkspaceNavigationTab,
  columns = false,
) {
  const home = androidWorkspaceNavigationState(state);
  if (tab !== "settings") return home;
  const page = columns
    ? rememberedSettingsPage(workspaceSelectionsIn(state.routes, {}))
    : undefined;
  const current = state.routes.find((route) => route.name === page);
  return settingsNavigationState(state, page, current?.params);
}

/** Settings stays selected while one of its pages is the topmost workspace route. */
export function androidWorkspaceSettingsOpen(state: NavigationState): boolean {
  return settingsOpenIn(
    state.routes
      .slice(0, state.index + 1)
      .filter((route) => WORKSPACE_ROUTES.has(route.name) || isSettingsRoute(route.name)),
  );
}
