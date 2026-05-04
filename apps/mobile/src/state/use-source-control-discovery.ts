import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  type SourceControlDiscoveryState,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";
import {
  refreshSourceControlDiscoveryForEnvironment,
  sourceControlDiscoveryTargetForEnvironment,
} from "./source-control-discovery-manager";

export function useSourceControlDiscovery(
  environmentId: EnvironmentId | null,
): SourceControlDiscoveryState {
  useEffect(() => {
    if (!environmentId) {
      return;
    }

    const refresh = () => {
      const client = getEnvironmentClient(environmentId);
      if (!client) {
        return;
      }

      void refreshSourceControlDiscoveryForEnvironment(environmentId, client.server);
    };

    refresh();
    return subscribeEnvironmentConnections(refresh);
  }, [environmentId]);

  const target = sourceControlDiscoveryTargetForEnvironment(environmentId);
  const targetKey = getSourceControlDiscoveryTargetKey(target);
  const state = useAtomValue(
    targetKey !== null
      ? sourceControlDiscoveryStateAtom(targetKey)
      : EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  );
  return targetKey === null ? EMPTY_SOURCE_CONTROL_DISCOVERY_STATE : state;
}
