import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import { type EnvironmentThreadShell, scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

const ARCHIVED_FETCH_TIMEOUT_MS = 5_000;

/** Fetches fresh archived shells before checking worktree ownership. Cached
    snapshots may omit a sibling archived on another client, so failures return
    null and callers skip worktree cleanup while allowing thread deletion. */
export async function fetchArchivedThreadShells(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<EnvironmentThreadShell> | null> {
  const atom = archivedSnapshotAtom(environmentId);
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    refresh: true,
    timeoutMs: ARCHIVED_FETCH_TIMEOUT_MS,
    reportDefect: false,
    reportFailure: false,
  });
  return result._tag === "Success"
    ? result.value.threads.map((thread) => scopeThreadShell(environmentId, thread))
    : null;
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
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
