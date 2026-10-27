import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo } from "react";

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
  const fallback = useMemo(
    () => (isReady ? pullRequestFallbackEnvironment(params, projects, environments) : null),
    [params, projects, environments, isReady],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rewrites the route params through the navigator to the fallback environment once connections are ready
  useEffect(() => {
    if (fallback) navigation.setParams(fallback);
  }, [fallback, navigation]);
}
