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
    readonly turnId: string;
    readonly state: string;
    readonly completedAt: string | null;
  } | null;
}

export interface ObservedThreadTurn {
  readonly turnId: string | null;
  readonly state: string | null;
}

export function resolveFirstSeenCompletedThreads(input: {
  readonly threads: ReadonlyArray<FirstSeenThreadInput>;
  readonly environmentSnapshotIds: ReadonlyArray<EnvironmentId>;
  readonly previouslyObservedThreadsByEnvironment: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<string, ObservedThreadTurn>
  >;
  readonly activeThreadKey?: string | null;
}): {
  readonly nextObservedThreadsByEnvironment: Map<EnvironmentId, Map<string, ObservedThreadTurn>>;
  readonly newlyUnreadThreads: ReadonlyArray<{
    readonly threadKey: string;
    readonly completedAt: string | null;
  }>;
} {
  const snapshotEnvironmentIds = new Set(input.environmentSnapshotIds);
  const nextObservedThreadsByEnvironment = new Map(
    [...input.previouslyObservedThreadsByEnvironment].map(([environmentId, threads]) => [
      environmentId,
      new Map(threads),
    ]),
  );
  const newlyUnreadThreads: Array<{
    readonly threadKey: string;
    readonly completedAt: string | null;
  }> = [];
  for (const environmentId of snapshotEnvironmentIds) {
    if (!nextObservedThreadsByEnvironment.has(environmentId)) {
      nextObservedThreadsByEnvironment.set(environmentId, new Map());
    }
  }

  for (const thread of input.threads) {
    if (!snapshotEnvironmentIds.has(thread.environmentId)) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const observedThread: ObservedThreadTurn = {
      turnId: thread.latestTurn?.turnId ?? null,
      state: thread.latestTurn?.state ?? null,
    };
    const previousEnvironmentThreads = input.previouslyObservedThreadsByEnvironment.get(
      thread.environmentId,
    );
    const previousThread = previousEnvironmentThreads?.get(threadKey);
    if (
      previousEnvironmentThreads !== undefined &&
      thread.latestTurn?.state === "completed" &&
      threadKey !== input.activeThreadKey &&
      (previousThread === undefined ||
        previousThread.turnId !== observedThread.turnId ||
        previousThread.state !== "completed")
    ) {
      newlyUnreadThreads.push({
        threadKey,
        completedAt: thread.latestTurn.completedAt,
      });
    }
    nextObservedThreadsByEnvironment.get(thread.environmentId)?.set(threadKey, observedThread);
  }

  return { nextObservedThreadsByEnvironment, newlyUnreadThreads };
}

export function useMarkFirstSeenCompletedThreadsUnread(): void {
  const threads = useThreadShells();
  const environmentSnapshotIds = useAtomValue(environmentSnapshotIdsAtom);
  const observedThreadsByEnvironmentRef = useRef<
    Map<EnvironmentId, Map<string, ObservedThreadTurn>>
  >(new Map());

  useEffect(() => {
    const { nextObservedThreadsByEnvironment, newlyUnreadThreads } =
      resolveFirstSeenCompletedThreads({
        threads,
        environmentSnapshotIds,
        previouslyObservedThreadsByEnvironment: observedThreadsByEnvironmentRef.current,
        activeThreadKey: useUiStateStore.getState().activeThreadVisit?.threadId ?? null,
      });
    for (const thread of newlyUnreadThreads) {
      useUiStateStore.getState().markThreadUnread(thread.threadKey, thread.completedAt);
    }

    observedThreadsByEnvironmentRef.current = nextObservedThreadsByEnvironment;
  }, [environmentSnapshotIds, threads]);
}
