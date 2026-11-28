import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";

export interface VcsRefsInvalidationTarget {
  readonly environmentId: EnvironmentId;
}

export interface CachedVcsRefsInvalidationTarget extends VcsRefsInvalidationTarget {
  readonly cwd: string;
}

export interface VcsRefsCacheState {
  readonly revision: number;
  readonly persistedCacheReadable: boolean;
}

const stateByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-state:${environmentId}`)),
);
const persistenceLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

export function vcsRefsCacheStateAtom(target: VcsRefsInvalidationTarget) {
  return stateByEnvironment(target.environmentId);
}

export function invalidateVcsRefs(
  registry: AtomRegistry.AtomRegistry,
  target: VcsRefsInvalidationTarget,
  persistedCacheReadable?: boolean,
): void {
  registry.update(vcsRefsCacheStateAtom(target), (state) => ({
    revision: state.revision + 1,
    persistedCacheReadable: persistedCacheReadable ?? state.persistedCacheReadable,
  }));
}

export function withVcsRefsPersistenceLock<A, E, R>(
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return persistenceLock.withPermit(environmentId)(effect);
}

/**
 * Clearing first prevents the restarted stream from rehydrating the invalidated
 * snapshot. A refresh that wins the lock is cleared afterward; one that loses
 * observes the new revision and cannot repersist its pre-mutation result.
 */
export const invalidateCachedVcsRefs = Effect.fn("VcsRefsState.invalidateCached")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
) {
  const cache = yield* Persistence.EnvironmentCacheStore;
  yield* withVcsRefsPersistenceLock(
    target.environmentId,
    Effect.gen(function* () {
      const persistedCacheReadable = yield* cache.clearVcsRefs(target.environmentId).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not remove invalidated cached Git refs.").pipe(
            Effect.annotateLogs({
              environmentId: target.environmentId,
              cwd: target.cwd,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
      invalidateVcsRefs(registry, target, persistedCacheReadable);
    }),
  );
});

// Ref digests from each cwd's last status refresh; the cached branch list is at least that new.
const refsDigestsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:vcs:refs-digests:${environmentId}`),
  ),
);

/** Skips the branch list reload when a status refresh saw the same refs as the last one. */
export const invalidateCachedVcsRefsIfChanged = Effect.fn("VcsRefsState.invalidateCachedIfChanged")(
  function* (
    registry: AtomRegistry.AtomRegistry,
    target: CachedVcsRefsInvalidationTarget,
    refsDigest: string | undefined,
  ) {
    const digestsAtom = refsDigestsByEnvironment(target.environmentId);
    if (refsDigest !== undefined && registry.get(digestsAtom).get(target.cwd) === refsDigest) {
      return;
    }
    registry.update(digestsAtom, (digests) => {
      const next = new Map(digests);
      if (refsDigest === undefined) next.delete(target.cwd);
      else next.set(target.cwd, refsDigest);
      return next;
    });
    yield* invalidateCachedVcsRefs(registry, target);
  },
);
