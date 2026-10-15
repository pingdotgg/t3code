import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo } from "react";

import { useProjects } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  pullRequestFallbackEnvironment,
  type PullRequestEnvironmentTarget,
} from "./pullRequestEnvironmentFallback";

/** Move a pull request route to a connected copy of its repository when its own is down. */
export function usePullRequestEnvironmentFallback(params: PullRequestEnvironmentTarget) {
  const navigation = useNavigation();
  const projects = useProjects();
  const connected = useWorkspaceEnvironments()
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => String(environment.environmentId))
    .join("\n");
  const fallback = useMemo(
    () => pullRequestFallbackEnvironment(params, projects, new Set(connected.split("\n"))),
    [params, projects, connected],
  );
  useEffect(() => {
    if (fallback) navigation.setParams(fallback);
  }, [fallback, navigation]);
}
