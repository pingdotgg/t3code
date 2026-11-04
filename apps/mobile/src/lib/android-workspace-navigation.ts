import type { NavigationState } from "@react-navigation/native";
import { isSettingsRoute } from "../features/settings/settings-navigation";
import { resetRootStack, type RootStackNavigation } from "./root-stack-reset";

function androidWorkspaceBackReturnsToThread(state: NavigationState) {
  const current = state.routes[state.index];
  const params = current?.params as ReactNavigation.RootParamList["Thread"] | undefined;
  return (
    current?.name === "Thread" &&
    state.routes[state.index - 1]?.name === "Thread" &&
    params !== undefined &&
    !parentThreadIsBelow(state, params)
  );
}

/** The root stack with only the workspace list. */
export function androidWorkspaceNavigationState(state: NavigationState) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  return { ...state, index: 0, routes: [home] };
}

export function resetAndroidWorkspace(navigation: RootStackNavigation) {
  resetRootStack(navigation, androidWorkspaceNavigationState);
}

export function parentThreadIsBelow(
  state: NavigationState,
  parent: ReactNavigation.RootParamList["Thread"],
) {
  if (!parent?.environmentId || !parent.threadId) return false;
  const previous = state.routes[state.index - 1];
  const params = previous?.params as ReactNavigation.RootParamList["Thread"] | undefined;
  return (
    previous?.name === "Thread" &&
    params?.environmentId === parent.environmentId &&
    params?.threadId === parent.threadId
  );
}

/**
 * How a thread link opened from inside a thread reaches its target. `navigate` would reuse the
 * current Thread route, so Back would skip the thread the link was in and land on the list.
 */
export function linkedThreadStep(
  state: NavigationState,
  target: ReactNavigation.RootParamList["Thread"],
): "stay" | "pop" | "push" {
  const params = state.routes[state.index]?.params as
    | ReactNavigation.RootParamList["Thread"]
    | undefined;
  if (
    state.routes[state.index]?.name === "Thread" &&
    params?.environmentId === target?.environmentId &&
    params?.threadId === target?.threadId
  ) {
    return "stay";
  }
  return parentThreadIsBelow(state, target) ? "pop" : "push";
}

export function returnToAndroidWorkspaceList(
  navigation: RootStackNavigation & { readonly goBack: () => void },
  selectTab: () => void,
) {
  const state = navigation.getState();
  if (state && androidWorkspaceBackReturnsToThread(state)) return navigation.goBack();
  selectTab();
  resetAndroidWorkspace(navigation);
}

// Split view: Thread, PullRequest, and a Settings page picked from the list swap the detail pane
// rather than stack, so they don't animate. Pages opened from a Settings page crossfade inside the
// pane's card; the default push edge-extends the incoming page, bleeding a stripe beside the list.
export function androidWorkspaceDestinationAnimation(
  route: { readonly key: string; readonly name: string },
  routes: readonly { readonly key: string; readonly name: string }[],
  usesSplitView: boolean,
) {
  if (!usesSplitView) return undefined;
  if (route.name === "Thread" || route.name === "PullRequest") return "none" as const;
  if (route.name === "Settings" || !isSettingsRoute(route.name)) return undefined;
  const below = routes[routes.findIndex((candidate) => candidate.key === route.key) - 1];
  return below?.name === "Settings" ? ("none" as const) : ("fade" as const);
}
