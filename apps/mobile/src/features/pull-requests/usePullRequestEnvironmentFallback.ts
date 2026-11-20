import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { useProjects } from "../../state/entities";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import {
  pullRequestFallbackEnvironment,
  type PullRequestEnvironmentTarget,
} from "./pullRequestEnvironmentFallback";

export function usePullRequestEnvironmentFallback(params: PullRequestEnvironmentTarget) {
  const navigation = useNavigation();
  const projects = useProjects();
  const isReady = useConnectionsReady();
  const environments = useWorkspaceEnvironments();
  const fallback = isReady ? pullRequestFallbackEnvironment(params, projects, environments) : null;
  // Only while focused: a screen kept as a placeholder throws on any navigation action.
  useFocusEffect(
    useCallback(() => {
      if (fallback) navigation.setParams(fallback);
    }, [fallback, navigation]),
  );
}
