import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

interface FirstSeenThreadInput {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestTurn: {
    readonly state: string;
    readonly completedAt: string | null;
  } | null;
}

export function resolveFirstSeenCompletedThreads(input: {
  readonly threads: ReadonlyArray<FirstSeenThreadInput>;
  readonly environmentSnapshotIds: ReadonlyArray<EnvironmentId>;
  readonly previouslySeenThreadKeysByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<string>>;
}): {
  readonly nextSeenThreadKeysByEnvironment: Map<EnvironmentId, Set<string>>;
  readonly newlyUnreadThreads: ReadonlyArray<{
    readonly threadKey: string;
    readonly completedAt: string | null;
  }>;
} {
  const snapshotEnvironmentIds = new Set(input.environmentSnapshotIds);
  const nextSeenThreadKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  const newlyUnreadThreads: Array<{
    readonly threadKey: string;
    readonly completedAt: string | null;
  }> = [];
  for (const environmentId of snapshotEnvironmentIds) {
    nextSeenThreadKeysByEnvironment.set(environmentId, new Set());
  }

  for (const thread of input.threads) {
    if (!snapshotEnvironmentIds.has(thread.environmentId)) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    nextSeenThreadKeysByEnvironment.get(thread.environmentId)?.add(threadKey);

    const previousThreadKeys = input.previouslySeenThreadKeysByEnvironment.get(
      thread.environmentId,
    );
    if (
      previousThreadKeys !== undefined &&
      !previousThreadKeys.has(threadKey) &&
      thread.latestTurn?.state === "completed"
    ) {
      newlyUnreadThreads.push({
        threadKey,
        completedAt: thread.latestTurn.completedAt,
      });
    }
  }

  return { nextSeenThreadKeysByEnvironment, newlyUnreadThreads };
}

export function useMarkFirstSeenCompletedThreadsUnread(): void {
  const threads = useThreadShells();
  const environmentSnapshotIds = useAtomValue(environmentSnapshotIdsAtom);
  const seenThreadKeysByEnvironmentRef = useRef<Map<EnvironmentId, Set<string>>>(new Map());

  useEffect(() => {
    const { nextSeenThreadKeysByEnvironment, newlyUnreadThreads } =
      resolveFirstSeenCompletedThreads({
        threads,
        environmentSnapshotIds,
        previouslySeenThreadKeysByEnvironment: seenThreadKeysByEnvironmentRef.current,
      });
    for (const thread of newlyUnreadThreads) {
      useUiStateStore.getState().markThreadUnread(thread.threadKey, thread.completedAt);
    }

    seenThreadKeysByEnvironmentRef.current = nextSeenThreadKeysByEnvironment;
  }, [environmentSnapshotIds, threads]);
}
