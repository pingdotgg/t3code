import { shellSnapshotStateAtom } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import { mobileRuntime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  endAllAgentLiveActivities,
  endEnvironmentLiveActivities,
  syncAgentLiveActivitiesForSnapshot,
} from "./liveActivityController";
import {
  registerAgentAwarenessConnection,
  unregisterAgentAwarenessConnection,
  unregisterAllAgentAwarenessConnections,
} from "./remoteRegistration";

const environmentUnsubscribers = new Map<EnvironmentId, () => void>();

export function startAgentAwarenessForEnvironment(connection: SavedRemoteConnection): void {
  const { environmentId } = connection;
  if (environmentUnsubscribers.has(environmentId)) {
    return;
  }

  registerAgentAwarenessConnection(connection);

  const sync = () => {
    const state = appAtomRegistry.get(shellSnapshotStateAtom(environmentId));
    void mobileRuntime
      .runPromise(
        syncAgentLiveActivitiesForSnapshot({
          environmentId,
          snapshot: state.data,
        }),
      )
      .catch(() => undefined);
  };

  const unsubscribe = appAtomRegistry.subscribe(shellSnapshotStateAtom(environmentId), sync);
  environmentUnsubscribers.set(environmentId, unsubscribe);
  sync();
}

export function stopAgentAwarenessForEnvironment(environmentId: EnvironmentId): void {
  environmentUnsubscribers.get(environmentId)?.();
  environmentUnsubscribers.delete(environmentId);
  unregisterAgentAwarenessConnection(environmentId);
  void mobileRuntime.runPromise(endEnvironmentLiveActivities(environmentId)).catch(() => undefined);
}

export function stopAllAgentAwareness(): void {
  for (const unsubscribe of environmentUnsubscribers.values()) {
    unsubscribe();
  }
  environmentUnsubscribers.clear();
  unregisterAllAgentAwarenessConnections();
  void mobileRuntime.runPromise(endAllAgentLiveActivities()).catch(() => undefined);
}
