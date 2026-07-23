import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ObservedThreadTurn {
  readonly turnId: string | null;
  readonly state: string | null;
}

interface ThreadObservationSeed {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
  } | null;
}

export interface FirstSeenCompletedThreadObservationSeedStore {
  readonly seed: (threads: ReadonlyArray<ThreadObservationSeed>) => void;
  readonly snapshot: () => ReadonlyMap<EnvironmentId, ReadonlyMap<string, ObservedThreadTurn>>;
}

export function createFirstSeenCompletedThreadObservationSeedStore(): FirstSeenCompletedThreadObservationSeedStore {
  const observationsByEnvironment = new Map<EnvironmentId, Map<string, ObservedThreadTurn>>();

  return {
    seed(threads) {
      for (const thread of threads) {
        const environmentObservations =
          observationsByEnvironment.get(thread.environmentId) ?? new Map();
        environmentObservations.set(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          {
            turnId: thread.latestTurn?.turnId ?? null,
            state: thread.latestTurn?.state ?? null,
          },
        );
        observationsByEnvironment.set(thread.environmentId, environmentObservations);
      }
    },
    snapshot() {
      return new Map(
        [...observationsByEnvironment].map(([environmentId, observations]) => [
          environmentId,
          new Map(observations),
        ]),
      );
    },
  };
}

export const archivedThreadObservationSeeds = createFirstSeenCompletedThreadObservationSeedStore();
