import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readEnvironmentApi } from "../environmentApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const ARCHIVED_THREADS_STALE_TIME_MS = 5_000;
const ARCHIVED_THREADS_IDLE_TTL_MS = 5 * 60_000;
const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";

export type ArchivedSnapshotEntry = {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
};

const knownArchivedThreadEnvironmentKeys = new Set<string>();

function makeArchivedThreadsEnvironmentKey(environmentIds: ReadonlyArray<EnvironmentId>): string {
  return environmentIds.toSorted().join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR);
}

function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return key
    .split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR)
    .map((environmentId) => EnvironmentId.make(environmentId));
}

const archivedThreadSnapshotsAtom = Atom.family((environmentKey: string) => {
  knownArchivedThreadEnvironmentKeys.add(environmentKey);
  return Atom.make(
    Effect.promise(async (): Promise<ReadonlyArray<ArchivedSnapshotEntry>> => {
      const environmentIds = parseArchivedThreadsEnvironmentKey(environmentKey);
      const snapshots = await Promise.all(
        environmentIds.map(async (environmentId) => {
          const api = readEnvironmentApi(environmentId);
          if (!api) {
            return null;
          }
          return {
            environmentId,
            snapshot: await api.orchestration.getArchivedShellSnapshot(),
          };
        }),
      );
      return snapshots.filter((snapshot) => snapshot !== null);
    }),
  ).pipe(
    Atom.swr({
      staleTime: ARCHIVED_THREADS_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(ARCHIVED_THREADS_IDLE_TTL_MS),
    Atom.withLabel(`archived-thread-snapshots:${environmentKey}`),
  );
});

function readArchivedThreadsError(
  result: AsyncResult.AsyncResult<ReadonlyArray<ArchivedSnapshotEntry>, unknown>,
): string | null {
  if (result._tag !== "Failure") {
    return null;
  }

  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Failed to load archived threads.";
}

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  for (const key of knownArchivedThreadEnvironmentKeys) {
    if (parseArchivedThreadsEnvironmentKey(key).includes(environmentId)) {
      appAtomRegistry.refresh(archivedThreadSnapshotsAtom(key));
    }
  }
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
  const atom = archivedThreadSnapshotsAtom(environmentKey);
  const result = useAtomValue(atom);
  const snapshots = Option.getOrElse(AsyncResult.value(result), () => []);
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom);
  }, [atom]);

  return {
    snapshots,
    error: readArchivedThreadsError(result),
    isLoading: result.waiting,
    refresh,
  };
}
