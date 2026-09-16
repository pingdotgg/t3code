import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
} from "./hostProcess.ts";
import { CommandResolutionCache, resolveCommandPath } from "./shell.ts";

export class NodeRuntimeUnavailableError extends Schema.TaggedError<NodeRuntimeUnavailableError>()(
  "NodeRuntimeUnavailableError",
  { feature: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `${this.feature} requires Node.js. Install Node.js and make sure node is on PATH, then retry.`;
  }
}

/** A standalone T3 binary runs its embedded CLI, regardless of script arguments. */
export const resolveNodeExecutable = Effect.fn("nodeRuntime.resolveNodeExecutable")(function* (
  feature: string,
  environment?: NodeJS.ProcessEnv,
) {
  const executablePath = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable)) return executablePath;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nodePath = yield* resolveCommandPath("node", {
    env: environment ?? (yield* HostProcessEnvironment),
  }).pipe(
    // Refresh immediately after the user installs Node and retries setup.
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.map((commandPath) => path.resolve(commandPath)),
    Effect.mapError((cause) => new NodeRuntimeUnavailableError({ feature, cause })),
  );
  // A launcher or symlink named node must not point back at the standalone app.
  const resolvedPath = yield* fs
    .realPath(nodePath)
    .pipe(Effect.mapError((cause) => new NodeRuntimeUnavailableError({ feature, cause })));
  if (resolvedPath === executablePath) return yield* new NodeRuntimeUnavailableError({ feature });
  // Launchers such as Vite+ dispatch by argv[0]; keep the node name intact.
  return nodePath;
});
