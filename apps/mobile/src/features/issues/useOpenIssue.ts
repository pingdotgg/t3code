import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard, Platform } from "react-native";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import type { IssueParams } from "./issueSelection";

/** Android keeps one workspace detail above Home; iOS pushes, or replaces a presenting sheet. */
export function useOpenIssue(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const replace = options?.replace;
  return useCallback(
    (params: IssueParams) => {
      Keyboard.dismiss();
      if (Platform.OS === "android") selectAndroidWorkspace({ name: "Issue", params });
      else if (replace) navigation.dispatch(StackActions.replace("Issue", params));
      else navigation.navigate("Issue", params);
    },
    [navigation, selectAndroidWorkspace, replace],
  );
}
