import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import {
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export function useWorkspaceListNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(() => {
    if (Platform.OS === "android") {
      dispatch?.({ type: "select", tab });
      resetAndroidWorkspace(navigation);
    } else if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace("Home"));
  }, [navigation, dispatch, tab]);
}

export function useWorkspaceBackNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  const returnToList = useWorkspaceListNavigation(tab);
  return useCallback(() => {
    if (Platform.OS === "android") {
      returnToAndroidWorkspaceList(navigation, () => dispatch?.({ type: "select", tab }));
    } else returnToList();
  }, [navigation, dispatch, tab, returnToList]);
}

export function useAndroidWorkspaceBack(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  const goBack = useWorkspaceBackNavigation(tab);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      // A chat opened from a PR, or a PR from a chat, keeps the tab it was opened from.
      if ((navigation.getState()?.index ?? 0) <= 1) dispatch?.({ type: "select", tab });
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else goBack();
        return true;
      });
      return () => subscription.remove();
    }, [navigation, goBack, dispatch, tab]),
  );
  return goBack;
}
