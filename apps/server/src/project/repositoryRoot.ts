import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The nearest ancestor of `projectRoot` holding a `.git` entry (a directory in a
 * clone, a file in a worktree), which places a subdirectory project inside a
 * thread's worktree. Null outside a checkout; unreadable paths count as absent.
 */ export const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  projectRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not check a path while finding a project's checkout", {
          path: candidate,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
  let current = path.resolve(projectRoot);
  while (!(yield* exists(path.join(current, ".git")))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
});
