import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

/**
 * Serializes attaching a repository's worktrees to threads with removing them,
 * so no checkout gets attached between a removal's last check and the removal.
 * Keyed by the canonical common Git directory, which every checkout of the
 * repository and every alias of its paths share.
 */
export const withRepositoryLease = <A, E, R>(
  commonDirKey: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withWorkspaceLease(`git-common-dir:${commonDirKey}`, effect);

/**
 * Holds several repository leases. They are taken in one sorted order, so two
 * holders of overlapping sets cannot each wait on the other.
 */
export const withRepositoryLeases = <A, E, R>(
  commonDirKeys: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  [...new Set(commonDirKeys)]
    .toSorted()
    .reduceRight((inner, key) => withRepositoryLease(key, inner), effect);
