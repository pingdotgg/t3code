import { StackActions, useNavigation, type NavigationAction } from "@react-navigation/native";
import { Platform } from "react-native";

import { rootNavigationRef } from "../../lib/rootNavigation";
import { useSelectWorkspaceDetail } from "./workspace/useSelectWorkspaceDetail";
import {
  workspaceDetailOpenStep,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace/workspace-detail-selection";

/**
 * Opens a thread or PR from another page. Android selects the detail; iOS reuses it on the root
 * stack (inspector previews are independent navigators) or else pushes. A `sheet` opens over the
 * detail on Android and alone over the current page on iOS.
 */
export function useOpenWorkspaceDetail() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => {
    if (Platform.OS === "android") selectDetail(detail, sheet);
    else if (sheet) navigation.navigate(sheet.name, sheet.params);
    else {
      const root = rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined;
      const state = root ?? navigation.getState();
      const step = state ? workspaceDetailOpenStep(state, detail) : { type: "push" as const };
      const dispatch = (action: NavigationAction) => {
        if (root?.key !== undefined) rootNavigationRef.dispatch({ ...action, target: root.key });
        else navigation.dispatch(action);
      };
      if (step.type === "stay") return;
      if (step.type === "pop") dispatch(StackActions.pop(step.count));
      else dispatch(StackActions.push(detail.name, detail.params));
    }
  };
}
