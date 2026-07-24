import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  archivedThreadObservationSeeds,
  type ObservedThreadTurn,
} from "../lib/firstSeenCompletedThreadObservations";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";

// Read snapshot readiness and the shells derived from those snapshots in one
// Atom transaction. Separate React subscriptions can briefly observe a new
// snapshot with the prior shell list and misclassify its history as newly
// completed on the following render.
const completedThreadObservationSnapshotAtom = Atom.make((get) => {
  const environmentIds: EnvironmentId[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      environmentIds.push(environmentId);
    }
  }
  return {
    environmentSnapshotIds: environmentIds,
    threads: get(environmentThreadShells.threadShellsAtom),
  };
}).pipe(Atom.withLabel("completed-thread-unread:observation-snapshot"));

interface FirstSeenThreadInput {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
    readonly completedAt: string | null;
  } | null;
}

export function resolveFirstSeenCompletedThreads(input: {
  readonly threads: ReadonlyArray<FirstSeenThreadInput>;
  readonly environmentSnapshotIds: ReadonlyArray<EnvironmentId>;
  readonly previouslyObservedThreadsByEnvironment: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<string, ObservedThreadTurn>
  >;
  readonly seededObservedThreadsByEnvironment?: ReadonlyMap<
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
    const nextEnvironmentThreads = nextObservedThreadsByEnvironment.get(environmentId);
    for (const [threadKey, observedThread] of input.seededObservedThreadsByEnvironment?.get(
      environmentId,
    ) ?? []) {
      if (!nextEnvironmentThreads?.has(threadKey)) {
        nextEnvironmentThreads?.set(threadKey, observedThread);
      }
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
    const previousThread =
      previousEnvironmentThreads?.get(threadKey) ??
      input.seededObservedThreadsByEnvironment?.get(thread.environmentId)?.get(threadKey);
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
  const { environmentSnapshotIds, threads } = useAtomValue(completedThreadObservationSnapshotAtom);
  const observedThreadsByEnvironmentRef = useRef<
    Map<EnvironmentId, Map<string, ObservedThreadTurn>>
  >(new Map());

  useEffect(() => {
    const { nextObservedThreadsByEnvironment, newlyUnreadThreads } =
      resolveFirstSeenCompletedThreads({
        threads,
        environmentSnapshotIds,
        previouslyObservedThreadsByEnvironment: observedThreadsByEnvironmentRef.current,
        seededObservedThreadsByEnvironment: archivedThreadObservationSeeds.snapshot(),
        activeThreadKey: useUiStateStore.getState().activeThreadVisit?.threadId ?? null,
      });
    for (const thread of newlyUnreadThreads) {
      useUiStateStore.getState().markThreadUnread(thread.threadKey, thread.completedAt);
    }

    observedThreadsByEnvironmentRef.current = nextObservedThreadsByEnvironment;
  }, [environmentSnapshotIds, threads]);
}
