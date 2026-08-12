import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThreadSelection } from "../../state/use-thread-selection";
import { resolveNativePullRequestTarget } from "./pullRequestNavigation";

/**
 * Opens the native pull-request manager when the git status already names a change
 * request this environment can read. Falls back to the system browser when it cannot.
 */
export function useOpenNativePullRequest() {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();

  return useCallback(
    async (input: {
      readonly url: string | null | undefined;
      readonly number?: number | null;
      readonly presentation?: "sheet" | "inspector" | "card";
    }) => {
      const url = input.url?.trim() ?? "";
      if (url.length === 0) {
        Alert.alert("No open PR", "This branch does not have an open pull request.");
        return;
      }
      const environmentId = selectedThread?.environmentId;
      const projectId = selectedThread?.projectId;
      const target =
        environmentId !== undefined && projectId !== undefined
          ? resolveNativePullRequestTarget({
              environmentId: String(environmentId),
              projectId: String(projectId),
              url,
              number: input.number,
              repositoryIdentity: selectedThreadProject?.repositoryIdentity ?? null,
            })
          : null;
      if (target !== null) {
        if (input.presentation === "sheet") {
          navigation.dispatch(StackActions.replace("PullRequestDetail", target));
          return;
        }
        navigation.navigate("PullRequestDetail", target);
        return;
      }
      if (!(await tryOpenExternalUrl(url, "pull-request"))) {
        Alert.alert("Unable to open PR", "The pull request could not be opened.");
      }
    },
    [navigation, selectedThread, selectedThreadProject],
  );
}
