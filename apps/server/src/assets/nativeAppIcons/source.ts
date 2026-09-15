import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type * as ServerConfig from "../../config.ts";

/**
 * One platform's way of turning an app reference into an icon file on disk.
 * The resolver picks the source for the host platform and owns caching and
 * error handling, so a source only has to find (or render) the file.
 */
export interface NativeAppIconSource {
  readonly platform: NodeJS.Platform;
  /** An image file the asset route can serve, or `null` when the app has no icon. */
  readonly resolve: (
    app: ToolActivityNativeAppReference,
  ) => Effect.Effect<
    string | null,
    PlatformError.PlatformError | Cause.TimeoutError,
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const existingFile = Effect.fn("NativeAppIconResolver.existingFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
    }),
  );
  return Option.isSome(info) && info.value.type === "File" ? filePath : null;
});
