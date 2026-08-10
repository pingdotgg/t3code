import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Serializes worktree preparation per repository. `git worktree add` — and the
 * fetch in front of it — takes the repository lock, so two bootstraps racing on
 * one project fail each other. Clients that start a batch of threads pace
 * themselves, but nothing stops two clients, or a batch and a normal send, from
 * overlapping.
 *
 * Repositories are independent, so each project cwd gets its own permit.
 */
export function makeWorktreeBootstrapLocks() {
  const locks = new Map<string, Semaphore.Semaphore>();

  return <A, E, R>(projectCwd: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    let lock = locks.get(projectCwd);
    if (lock === undefined) {
      // Created synchronously: an Effect-returning constructor would suspend
      // between the lookup and the insert, and two fibers could each install
      // their own permit for the same repository.
      lock = Semaphore.makeUnsafe(1);
      locks.set(projectCwd, lock);
    }
    return lock.withPermits(1)(effect);
  };
}
