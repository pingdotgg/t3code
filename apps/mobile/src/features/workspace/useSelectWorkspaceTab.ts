import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard, Platform } from "react-native";
import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Switch workspace tabs from inside the sidebar, closing any open detail first. */
export function useSelectWorkspaceTab() {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const { dispatch } = workspace;
  return useCallback(
    (tab: WorkspaceTab) => {
      Keyboard.dismiss();
      if (Platform.OS === "android") resetAndroidWorkspace(navigation);
      else navigation.dispatch(StackActions.popTo("Home"));
      dispatch({ type: "select", tab });
    },
    [dispatch, navigation],
  );
}
