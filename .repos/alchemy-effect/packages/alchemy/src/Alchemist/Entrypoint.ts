import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { UserFacingError } from "../UserFacingError.ts";

export class StackEntrypointError extends Data.TaggedError(
  "StackEntrypointError",
)<{ readonly message: string }> {
  readonly [UserFacingError] = true;
}

export const DEFAULT_ENTRYPOINT = "alchemy.run.ts";

/**
 * The absolute path of the stack entrypoint, or the user-facing error for
 * a missing one. Kept apart from `Session.ts` so the `alchemy dev`
 * supervisor can check the entry before it starts an exec child, without
 * loading the engine that module carries.
 */
export const resolveStackEntrypoint = Effect.fn(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.resolve(main);
  if (!(yield* fs.exists(absolutePath))) {
    return yield* Effect.fail(
      new StackEntrypointError({
        message: `Stack entrypoint '${main}' does not exist in '${path.dirname(absolutePath)}'. Run this command from an Alchemy project or pass --config <path>.`,
      }),
    );
  }
  return absolutePath;
});
