import { useAtomValue } from "@effect/atom-react";
import {
  type SourceControlDiscoveryTarget,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@t3tools/client-runtime";
import { EnvironmentId, type SourceControlDiscoveryResult } from "@t3tools/contracts";
import { useEffect } from "react";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;
const SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS = 30_000;
const SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS = 5 * 60_000;

interface SourceControlDiscoveryTargetInput {
  readonly environmentId?: EnvironmentId | null;
}

function sourceControlDiscoveryTarget(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryTarget {
  const environmentId = input?.environmentId ?? null;
  if (!environmentId) {
    return SOURCE_CONTROL_DISCOVERY_TARGET;
  }
  return readPrimaryEnvironmentDescriptor()?.environmentId === environmentId
    ? SOURCE_CONTROL_DISCOVERY_TARGET
    : { key: environmentId };
}

const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: (key) => {
    if (key === SOURCE_CONTROL_DISCOVERY_TARGET.key) {
      const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
      const primaryConnection = primaryEnvironmentId
        ? readEnvironmentConnection(primaryEnvironmentId)
        : null;
      if (primaryConnection) {
        return primaryConnection.client.server;
      }
      try {
        return readLocalApi()?.server ?? null;
      } catch {
        return null;
      }
    }
    const environmentId = EnvironmentId.make(key);
    const connection = readEnvironmentConnection(environmentId);
    if (connection) {
      return connection.client.server;
    }
    return null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
  staleTimeMs: SOURCE_CONTROL_DISCOVERY_STALE_TIME_MS,
  idleTtlMs: SOURCE_CONTROL_DISCOVERY_IDLE_TTL_MS,
});

export function refreshSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(sourceControlDiscoveryTarget(input));
}

export function getSourceControlDiscoverySnapshot(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  return sourceControlDiscoveryManager.getSnapshot(sourceControlDiscoveryTarget(input));
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
}

export function useSourceControlDiscovery(
  input?: SourceControlDiscoveryTargetInput,
): SourceControlDiscoveryState {
  const targetKey =
    getSourceControlDiscoveryTargetKey(sourceControlDiscoveryTarget(input)) ??
    SOURCE_CONTROL_DISCOVERY_TARGET.key;

  useEffect(() => sourceControlDiscoveryManager.watch({ key: targetKey }), [targetKey]);

  return useAtomValue(sourceControlDiscoveryStateAtom(targetKey));
}
