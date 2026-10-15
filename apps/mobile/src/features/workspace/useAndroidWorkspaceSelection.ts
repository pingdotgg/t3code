import { CommonActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard } from "react-native";
import {
  androidWorkspaceNavigationState,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export function useAndroidWorkspaceSelection() {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(
    (
      destination: AndroidWorkspaceDestination,
      reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
    ) => {
      Keyboard.dismiss();
      dispatch?.({
        type: "select",
        tab: destination.name === "Thread" ? "threads" : "pullRequests",
      });
      navigation.dispatch((state) =>
        CommonActions.reset(androidWorkspaceNavigationState(state, destination, reviewers)),
      );
    },
    [navigation, dispatch],
  );
}

/** Switches Chats/PRs from the bottom bar or the split-view sidebar, closing the open detail. */
export function useSelectAndroidWorkspaceTab() {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const dispatch = workspace?.dispatch;
  const selectedTab = workspace?.state.selectedTab;
  return useCallback(
    (tab: WorkspaceTab) => {
      Keyboard.dismiss();
      if (tab === selectedTab) return;
      dispatch?.({ type: "select", tab });
      navigation.dispatch((state) => CommonActions.reset(androidWorkspaceNavigationState(state)));
    },
    [navigation, dispatch, selectedTab],
  );
}
