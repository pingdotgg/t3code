import { StackActions, useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";

import { useSelectWorkspaceDetail } from "./workspace/useSelectWorkspaceDetail";
import type { WorkspaceDetail, WorkspaceDetailSheet } from "./workspace/workspace-detail-selection";

/**
 * Opens a thread or pull request from another page. Android shows one detail page at a time, so
 * it selects the detail; iOS pushes it over the current page, so Back returns there. A `sheet`
 * opens over the detail on Android and on its own over the current page on iOS.
 */
export function useOpenWorkspaceDetail() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => {
    if (Platform.OS === "android") selectDetail(detail, sheet);
    else if (sheet) navigation.navigate(sheet.name, sheet.params);
    else navigation.dispatch(StackActions.push(detail.name, detail.params));
  };
}
