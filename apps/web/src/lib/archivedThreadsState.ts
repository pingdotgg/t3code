import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import { type EnvironmentThreadShell, scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
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

/** One-shot fetch of an environment's archived thread shells. The archived
    snapshot atom is only mounted while Settings → Archived is open, so a
    synchronous read can miss; this asks for a fresh result, bounded so a
    reconnecting environment cannot hang the caller, and falls back to the
    last snapshot the atom already holds. Returns null when neither exists so
    callers can fail soft. */
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
  const snapshot =
    result._tag === "Success"
      ? Option.some(result.value)
      : AsyncResult.value(appAtomRegistry.get(atom));
  return Option.match(snapshot, {
    onNone: () => null,
    onSome: (value) => value.threads.map((thread) => scopeThreadShell(environmentId, thread)),
  });
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
