import type { CommonActions, NavigationState } from "@react-navigation/native";

export type AndroidWorkspaceDestination =
  | { readonly name: "Thread"; readonly params: ReactNavigation.RootParamList["Thread"] }
  | { readonly name: "PullRequest"; readonly params: ReactNavigation.RootParamList["PullRequest"] };

export type AndroidWorkspaceResetAction = ReturnType<typeof CommonActions.reset> & {
  readonly target: string;
};

interface WorkspaceNavigation {
  readonly dispatch: (action: AndroidWorkspaceResetAction) => void;
  readonly getParent: () => WorkspaceNavigation | undefined;
  readonly getState: () => NavigationState | undefined;
  /** Only on the navigation container, whose `getState` stays empty until the first action. */
  readonly getRootState?: () => NavigationState | undefined;
}

const detailIdentity = {
  Thread: ["environmentId", "threadId"],
  PullRequest: ["environmentId", "projectId", "repository", "number", "host"],
} as const;

// Back returns to the detail a chat, PR, or subagent was opened from. A copy of the current
// detail directly below it, which confirming a Git action from the inline inspector can leave,
// is not a destination, so Back returns to the list instead.
function androidWorkspaceBackReturnsToDetail(state: NavigationState) {
  const current = state.routes[state.index];
  const previous = state.routes[state.index - 1];
  if (!current || (previous?.name !== "Thread" && previous?.name !== "PullRequest")) return false;
  if (current.name !== previous.name) return true;
  const currentParams = current.params as Readonly<Record<string, unknown>> | undefined;
  const previousParams = previous.params as Readonly<Record<string, unknown>> | undefined;
  return detailIdentity[previous.name].some(
    (key) => currentParams?.[key] !== previousParams?.[key],
  );
}

export function androidWorkspaceNavigationState(
  state: NavigationState,
  destination?: AndroidWorkspaceDestination,
  reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  if (!destination) return { ...state, index: 0, routes: [home] };
  const identity = detailIdentity[destination.name];
  const params = destination.params as Readonly<Record<string, unknown>>;
  const existing = state.routes.findLast((route) => {
    if (route.name !== destination.name) return false;
    const current = route.params as Readonly<Record<string, unknown>> | undefined;
    return identity.every((key) => current?.[key] === params[key]);
  });
  return {
    ...state,
    index: reviewers ? 2 : 1,
    routes: [
      home,
      { ...existing, ...destination },
      ...(reviewers ? [{ name: "PullRequestReviewers", params: reviewers }] : []),
    ],
  };
}

export function androidWorkspaceRootState(
  navigation: Pick<WorkspaceNavigation, "getParent" | "getState" | "getRootState">,
) {
  let root = navigation;
  for (let parent = root.getParent(); parent; parent = root.getParent()) root = parent;
  return root.getRootState?.() ?? root.getState();
}

/**
 * Resets the root stack to a workspace list or detail. Always reads and targets the root
 * navigator: the sidebar and rail render in the root layout, where `useNavigation()` is the
 * container, and a container dispatch runs on the deepest focused navigator. With Settings
 * or New task open, that is their nested stack, which rejects the reset.
 */
export function resetAndroidWorkspace(
  navigation: WorkspaceNavigation,
  destination?: AndroidWorkspaceDestination,
  reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
) {
  const state = androidWorkspaceRootState(navigation);
  if (!state) return;
  // Same shape as `CommonActions.reset`, which would pull React Native into node tests.
  navigation.dispatch({
    type: "RESET",
    payload: androidWorkspaceNavigationState(state, destination, reviewers),
    target: state.key,
  });
}

export function parentThreadIsBelow(
  state: NavigationState,
  parent: ReactNavigation.RootParamList["Thread"],
) {
  const previous = state.routes[state.index - 1];
  const params = previous?.params as ReactNavigation.RootParamList["Thread"] | undefined;
  return (
    previous?.name === "Thread" &&
    params?.environmentId === parent.environmentId &&
    params.threadId === parent.threadId
  );
}

export function returnToAndroidWorkspaceList(
  navigation: WorkspaceNavigation & { readonly goBack: () => void },
  selectTab: () => void,
) {
  const state = navigation.getState();
  if (state && androidWorkspaceBackReturnsToDetail(state)) return navigation.goBack();
  selectTab();
  resetAndroidWorkspace(navigation);
}

// In the split view these destinations swap the detail pane beside the sidebar instead of
// stacking over Home, so the default slide-in would show a layer that is not there.
export function androidWorkspaceDestinationAnimation(routeName: string, usesSplitView: boolean) {
  return usesSplitView && (routeName === "Thread" || routeName === "PullRequest")
    ? ("none" as const)
    : undefined;
}
