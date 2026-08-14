import { useAtomValue } from "@effect/atom-react";
import {
  createArchivedThreadsManager,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
  readArchivedThreadsSnapshotState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { readEnvironmentConnection, subscribeEnvironmentConnections } from "./environments/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";

const archivedThreadsManager = createArchivedThreadsManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId);
    return connection
      ? {
          getArchivedShellSnapshot: connection.client.orchestration.getArchivedShellSnapshot,
        }
      : null;
  },
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  archivedThreadsManager.refreshForEnvironment(environmentId);
}

let nextConnectionEpoch = 0;
const connectionEpochs = new WeakMap<object, number>();

function readConnectionKey(
  environmentKey: string,
  getConnection: (environmentId: EnvironmentId) => object | null = readEnvironmentConnection,
): string {
  return parseArchivedThreadsEnvironmentKey(environmentKey)
    .map((environmentId) => {
      const connection = getConnection(environmentId);
      if (!connection) {
        return `${environmentId}:disconnected`;
      }
      let epoch = connectionEpochs.get(connection);
      if (epoch === undefined) {
        nextConnectionEpoch += 1;
        epoch = nextConnectionEpoch;
        connectionEpochs.set(connection, epoch);
      }
      return `${environmentId}:${epoch}`;
    })
    .join("\u001f");
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>) {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const readCurrentConnectionKey = useCallback(
    () => readConnectionKey(environmentKey),
    [environmentKey],
  );
  const connectionKey = useSyncExternalStore(
    subscribeEnvironmentConnections,
    readCurrentConnectionKey,
    readCurrentConnectionKey,
  );
  const previousConnectionRef = useRef({ environmentKey, connectionKey });
  const result = useAtomValue(archivedThreadsManager.getAtom(environmentKey));
  const refresh = useCallback(() => {
    archivedThreadsManager.refresh(parseArchivedThreadsEnvironmentKey(environmentKey));
  }, [environmentKey]);

  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = { environmentKey, connectionKey };
    if (previous.environmentKey !== environmentKey || previous.connectionKey === connectionKey) {
      return;
    }
    archivedThreadsManager.refresh(parseArchivedThreadsEnvironmentKey(environmentKey));
  }, [connectionKey, environmentKey]);

  return {
    ...readArchivedThreadsSnapshotState(result),
    refresh,
  };
}

export const __testing = {
  readConnectionKey,
};
