import { StackActions, useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";

import { useSelectWorkspaceDetail } from "./workspace/useSelectWorkspaceDetail";
import {
  workspaceDetailOpenStep,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "./workspace/workspace-detail-selection";

/**
 * Opens a thread or pull request from another page. Android shows one detail page at a time, so
 * it selects the detail; iOS pops back to it when that page is already on the stack (so composing
 * from a drilled-in page returns there) and otherwise pushes over the current page. A `sheet`
 * opens over the detail on Android and on its own over the current page on iOS.
 */
export function useOpenWorkspaceDetail() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => {
    if (Platform.OS === "android") selectDetail(detail, sheet);
    else if (sheet) navigation.navigate(sheet.name, sheet.params);
    else {
      const state = navigation.getState();
      const step = state ? workspaceDetailOpenStep(state, detail) : { type: "push" as const };
      if (step.type === "stay") return;
      if (step.type === "pop") navigation.dispatch(StackActions.pop(step.count));
      else navigation.dispatch(StackActions.push(detail.name, detail.params));
    }
  };
}
