import { CommonActions, NavigationContainerRefContext } from "@react-navigation/native";
import { use, useCallback } from "react";
import { Keyboard } from "react-native";
import {
  androidWorkspaceNavigationState,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

export function useAndroidWorkspaceSelection() {
  // Resets the root stack even while a nested navigator such as Settings has
  // focus; a plain dispatch from the workspace layout reaches that navigator,
  // which has no Home or Thread routes.
  const root = use(NavigationContainerRefContext);
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(
    (
      destination: AndroidWorkspaceDestination,
      reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
    ) => {
      const state = root?.getRootState();
      if (!root || !state) return;
      Keyboard.dismiss();
      dispatch?.({
        type: "select",
        tab: destination.name === "Thread" ? "threads" : "pullRequests",
      });
      root.dispatch({
        ...CommonActions.reset(androidWorkspaceNavigationState(state, destination, reviewers)),
        target: state.key,
      });
    },
    [root, dispatch],
  );
}
