import {
  CommonActions,
  StackActions,
  useFocusEffect,
  useNavigation,
} from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export function useWorkspaceListNavigation(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else if (Platform.OS === "android") {
      dispatch?.({ type: "select", tab });
      navigation.dispatch((state) => CommonActions.reset(androidWorkspaceNavigationState(state)));
    } else navigation.dispatch(StackActions.replace("Home"));
  }, [navigation, dispatch, tab]);
}

/** Details use native Back; focused sheets and nested screens take priority. */
export function useAndroidWorkspaceBack(tab: WorkspaceTab) {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  const returnToList = useWorkspaceListNavigation(tab);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      if ((navigation.getState()?.index ?? 0) <= 1) dispatch?.({ type: "select", tab });
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) {
          Keyboard.dismiss();
          return true;
        }
        if (navigation.canGoBack()) return false;
        returnToList();
        return true;
      });
      return () => subscription.remove();
    }, [navigation, returnToList, dispatch, tab]),
  );
  return returnToList;
}
