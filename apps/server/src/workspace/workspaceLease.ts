import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/**
 * The lease key for a checkout: its real path, or for a checkout that is gone
 * the real path of the deepest existing ancestor plus the missing tail.
 * Terminal startup, worktree removal and worktree revival all key on this, so
 * a symlinked T3 home cannot hand them different leases for one directory.
 */
export const resolveWorkspaceLeasePath = Effect.fn("resolveWorkspaceLeasePath")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missingSegments: string[] = [];
  let ancestor = path.resolve(cwd);
  while (true) {
    const real = yield* fs.realPath(ancestor).pipe(Effect.option);
    if (real._tag === "Some") return path.resolve(real.value, ...missingSegments);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return path.resolve(cwd);
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
  }
});

/**
 * Serializes checkout removal, revival and terminal startup on one checkout.
 * Pass a key from `resolveWorkspaceLeasePath`. The lease is not reentrant.
 */
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
