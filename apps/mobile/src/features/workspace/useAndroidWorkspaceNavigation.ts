import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import {
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

function useWorkspaceListNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return () => {
    if (Platform.OS === "android") {
      dispatch?.({ type: "select", tab });
      resetAndroidWorkspace(navigation);
    } else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  };
}

export function useWorkspaceBackNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  const returnToList = useWorkspaceListNavigation(tab);
  return () => {
    if (Platform.OS === "android") {
      returnToAndroidWorkspaceList(navigation, () => dispatch?.({ type: "select", tab }));
    } else returnToList();
  };
}

export function useAndroidWorkspaceBack(tab: WorkspaceTab) {
  const dispatch = useWorkspaceTabs()?.dispatch;
  const goBack = useWorkspaceBackNavigation(tab);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      dispatch?.({ type: "select", tab });
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack, dispatch, tab]),
  );
  return goBack;
}
