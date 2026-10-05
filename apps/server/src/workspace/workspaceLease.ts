import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Coordinates checkout removal and startup across threads using the same resolved cwd. */
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

export const resolveWorkspacePath = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(cwd);
    const missingNames: string[] = [];
    while (true) {
      const realPath = yield* fs.realPath(current).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (realPath !== null) return path.join(realPath, ...missingNames);
      const target = yield* resolveSymlinkTarget(current);
      const parent = path.dirname(target);
      if (parent === target) return yield* fs.realPath(target);
      missingNames.unshift(path.basename(target));
      current = parent;
    }
  });
