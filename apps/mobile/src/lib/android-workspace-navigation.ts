import type { NavigationState } from "@react-navigation/native";
import { resetRootStack, type RootStackNavigation } from "./root-stack-reset";

// Back follows history; Git confirmations can stack copies of the current thread, so skip those too.
function androidWorkspaceBackTarget(state: NavigationState) {
  let index = state.index;
  const params = state.routes[index]?.params as ReactNavigation.RootParamList["Thread"] | undefined;
  if (state.routes[index]?.name === "Thread" && params) {
    while (parentThreadIsBelow({ ...state, index }, params)) index -= 1;
  }
  return index - 1;
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
) {
  const state = navigation.getState();
  const index = state ? androidWorkspaceBackTarget(state) : -1;
  if (!state || index < 0) return resetAndroidWorkspace(navigation);
  if (index === state.index - 1) return navigation.goBack();
  resetRootStack(navigation, () => ({ ...state, index, routes: state.routes.slice(0, index + 1) }));
}

// In the split view these destinations swap the detail pane beside the sidebar instead of
// stacking over Home, so the default slide-in would show a layer that is not there.
export function androidWorkspaceDestinationAnimation(routeName: string, usesSplitView: boolean) {
  return usesSplitView && (routeName === "Thread" || routeName === "PullRequest")
    ? ("none" as const)
    : undefined;
}
