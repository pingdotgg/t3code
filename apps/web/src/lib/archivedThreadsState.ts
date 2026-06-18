import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

const archivedSnapshotsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get) => {
    const snapshots: ArchivedSnapshotEntry[] = [];
    let error: string | null = null;
    let isLoading = false;

    for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
      const result = get(
        orchestrationEnvironment.archivedShellSnapshot({
          environmentId,
          input: {},
        }),
      );
      isLoading ||= result.waiting;
      const snapshot = Option.getOrNull(AsyncResult.value(result));
      if (snapshot !== null) {
        snapshots.push({ environmentId, snapshot });
      }
      if (error === null && result._tag === "Failure") {
        const cause = Cause.squash(result.cause);
        error =
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load archived threads.";
      }
    }

    return {
      snapshots,
      error,
      isLoading,
    };
  }).pipe(Atom.withLabel(`web:archived-thread-snapshots:${environmentKey}`)),
);

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
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
