import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useThreadShells } from "../state/entities";
import { environmentShell } from "../state/shell";
import { useUiStateStore } from "../uiStateStore";

const environmentSnapshotIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const environmentIds: EnvironmentId[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      environmentIds.push(environmentId);
    }
  }
  return environmentIds;
}).pipe(Atom.withLabel("completed-thread-unread:snapshot-environments"));

export function useMarkFirstSeenCompletedThreadsUnread(): void {
  const threads = useThreadShells();
  const environmentSnapshotIds = useAtomValue(environmentSnapshotIdsAtom);
  const seenThreadKeysByEnvironmentRef = useRef<Map<EnvironmentId, Set<string>>>(new Map());

  useEffect(() => {
    const snapshotEnvironmentIds = new Set(environmentSnapshotIds);
    const nextThreadKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
    for (const environmentId of snapshotEnvironmentIds) {
      nextThreadKeysByEnvironment.set(environmentId, new Set());
    }

    for (const thread of threads) {
      if (!snapshotEnvironmentIds.has(thread.environmentId)) {
        continue;
      }

      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      const nextThreadKeys = nextThreadKeysByEnvironment.get(thread.environmentId);
      nextThreadKeys?.add(threadKey);

      const previousThreadKeys = seenThreadKeysByEnvironmentRef.current.get(thread.environmentId);
      if (
        previousThreadKeys !== undefined &&
        !previousThreadKeys.has(threadKey) &&
        thread.latestTurn?.state === "completed"
      ) {
        useUiStateStore.getState().markThreadUnread(threadKey, thread.latestTurn.completedAt);
      }
    }

    seenThreadKeysByEnvironmentRef.current = nextThreadKeysByEnvironment;
  }, [environmentSnapshotIds, threads]);
}
