import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// ponytail: per-cwd mutex shared by restore and capture so neither validates or
// mutates workspace checkpoints against a concurrent peer for the same cwd.
const workspaceCheckpointLocks = new Map<string, Semaphore.Semaphore>();

export const withWorkspaceCheckpointLock = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let lock = workspaceCheckpointLocks.get(cwd);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    workspaceCheckpointLocks.set(cwd, lock);
  }
  return lock.withPermit(effect);
};
