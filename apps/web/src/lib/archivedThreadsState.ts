import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadsManager,
  makeArchivedThreadsEnvironmentKey,
  readArchivedThreadsSnapshotState,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const archivedThreadsManager = createArchivedThreadsManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => readEnvironmentApi(environmentId)?.orchestration ?? null,
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  archivedThreadsManager.refreshForEnvironment(environmentId);
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const atom = archivedThreadsManager.getAtom(environmentKey);
  const result = useAtomValue(atom);
  const refresh = useCallback(() => {
    archivedThreadsManager.refresh(environmentIds);
  }, [environmentIds]);

  return {
    ...readArchivedThreadsSnapshotState(result),
    refresh,
  };
}
