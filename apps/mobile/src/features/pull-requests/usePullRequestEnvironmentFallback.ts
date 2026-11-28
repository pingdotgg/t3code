import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../../connection/catalog";
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
  const connection = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(EnvironmentId.make(params.environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const fallback = isReady
    ? pullRequestFallbackEnvironment(params, projects, environments, connection.lastFailure)
    : null;
  // Only while focused: a screen kept as a placeholder throws on any navigation action.
  useFocusEffect(
    useCallback(() => {
      if (fallback) navigation.setParams(fallback);
    }, [fallback, navigation]),
  );
}
