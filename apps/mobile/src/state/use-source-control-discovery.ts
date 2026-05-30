import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  type SourceControlDiscoveryClient,
  type SourceControlDiscoveryState,
  type SourceControlDiscoveryTarget,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@t3tools/client-runtime";
import type { EnvironmentId, SourceControlDiscoveryResult } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

const sourceControlDiscoveryManager = createSourceControlDiscoveryManager<EnvironmentId>({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => getEnvironmentClient(environmentId)?.server ?? null,
  subscribeClientChanges: subscribeEnvironmentConnections,
});

function sourceControlDiscoveryTargetForEnvironment(
  environmentId: EnvironmentId | null,
): SourceControlDiscoveryTarget<EnvironmentId> {
  return { key: environmentId ?? null };
}

export function refreshSourceControlDiscoveryForEnvironment(
  environmentId: EnvironmentId | null,
  client?: SourceControlDiscoveryClient | null,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(
    sourceControlDiscoveryTargetForEnvironment(environmentId),
    client ?? undefined,
  );
}

export function invalidateSourceControlDiscoveryForEnvironment(
  environmentId: EnvironmentId | null,
): void {
  sourceControlDiscoveryManager.invalidate(
    sourceControlDiscoveryTargetForEnvironment(environmentId),
  );
}

export function resetSourceControlDiscoveryState(): void {
  sourceControlDiscoveryManager.reset();
}

export function resetSourceControlDiscoveryStateForTests(): void {
  resetSourceControlDiscoveryState();
}

export function useSourceControlDiscovery(
  environmentId: EnvironmentId | null,
): SourceControlDiscoveryState {
  const target = useMemo(
    () => sourceControlDiscoveryTargetForEnvironment(environmentId),
    [environmentId],
  );

  useEffect(() => {
    return sourceControlDiscoveryManager.watch(target);
  }, [target]);

  const targetKey = getSourceControlDiscoveryTargetKey(target);
  const state = useAtomValue(
    targetKey !== null
      ? sourceControlDiscoveryStateAtom(targetKey)
      : EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  );
  return targetKey === null ? EMPTY_SOURCE_CONTROL_DISCOVERY_STATE : state;
}
