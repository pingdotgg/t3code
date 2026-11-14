import {
  type EnvironmentId as EnvironmentIdType,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import { cachedThreadState, type ThreadResumeCache } from "./threadStateSnapshot.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

import { makeEnvironmentThreadState } from "./environmentThreadState.ts";

export * from "./environmentThreadState.ts";

function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ThreadSnapshotLoader.ThreadSnapshotLoader
    | R,
    E
  >,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({
      snapshot: undefined,
      owner: undefined,
    })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          const live = threadStateChanges(environmentId, threadId, resume);
          return resume.snapshot === undefined
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * as BoundedThreadSnapshotLoader from "./boundedThreadSnapshotHttp.ts";
export * as ThreadHistoryController from "./threadHistoryController.ts";
export type { ThreadHistoryLoadEarlierResult } from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadFamilies.ts";
export * from "./olderSettledThreads.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
export * from "./threadStateSnapshot.ts";
export * from "./threadTagFilter.ts";
