import {
  type SourceControlDiscoveryClient,
  type SourceControlDiscoveryTarget,
  createSourceControlDiscoveryManager,
} from "@t3tools/client-runtime";
import { EnvironmentId, type SourceControlDiscoveryResult } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { getEnvironmentClient } from "./environment-session-registry";

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: (key) => getEnvironmentClient(EnvironmentId.make(key))?.server ?? null,
});

export function sourceControlDiscoveryTargetForEnvironment(
  environmentId: EnvironmentId | null,
): SourceControlDiscoveryTarget {
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
