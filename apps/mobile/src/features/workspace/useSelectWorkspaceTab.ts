import { StackActions, useNavigation } from "@react-navigation/native";
import { Keyboard } from "react-native";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

/** Switch workspace tabs from inside the sidebar, closing any open detail first. */
export function useSelectWorkspaceTab() {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const selectedTab = workspace.state.selectedTab;
  const { dispatch } = workspace;
  return (tab: WorkspaceTab) => {
    if (tab === selectedTab) return;
    Keyboard.dismiss();
    if (navigation.getState()?.index) navigation.dispatch(StackActions.popToTop());
    dispatch({ type: "select", tab });
  };
}
