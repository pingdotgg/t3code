import { CommonActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard } from "react-native";
import {
  androidWorkspaceNavigationState,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import {
  isFocusedThreadWorkspace,
  rememberedThreadWorkspaceNavigationState,
} from "./threadWorkspaceNavigationMemory";

export function useAndroidWorkspaceSelection() {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(
    (
      destination: AndroidWorkspaceDestination,
      reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
    ) => {
      if (
        destination.name === "Thread" &&
        isFocusedThreadWorkspace(navigation.getState(), destination.params)
      )
        return;
      Keyboard.dismiss();
      dispatch?.({
        type: "select",
        tab: destination.name === "Thread" ? "threads" : "pullRequests",
      });
      navigation.dispatch((state) =>
        CommonActions.reset(
          (destination.name === "Thread"
            ? rememberedThreadWorkspaceNavigationState(state, destination.params, true)
            : null) ?? androidWorkspaceNavigationState(state, destination, reviewers),
        ),
      );
    },
    [navigation, dispatch],
  );
}
