import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "./hostProcess.ts";
import { CommandResolutionCache, resolveCommandPath } from "./shell.ts";

const NodeRuntimeFeature = Schema.Literals([
  "Local device support",
  "Device automation",
  "Antigravity",
  "Antigravity sign-in",
]);

export const nodeRuntimeUnavailableMessage = (feature: typeof NodeRuntimeFeature.Type): string =>
  `${feature} requires Node.js. Install Node.js and make sure node is on PATH, then retry.`;

export class NodeRuntimeUnavailableError extends Schema.TaggedError<NodeRuntimeUnavailableError>()(
  "NodeRuntimeUnavailableError",
  { feature: NodeRuntimeFeature, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return nodeRuntimeUnavailableMessage(this.feature);
  }
}

export interface SelfInvocation {
  /** The binary to spawn: Node, Electron (with `ELECTRON_RUN_AS_NODE`), or the packaged T3. */
  readonly command: string;
  /**
   * The absolute entrypoint script to place before the subcommand, or
   * undefined for the packaged binary, which dispatches subcommands from
   * argv[2] and treats a leading path as the subcommand itself.
   */
  readonly entrypoint: string | undefined;
}

/**
 * How another process runs this T3 install's CLI, for hidden subcommands the
 * server hands to children such as `acp-mcp-bridge`. `process.execPath` plus
 * `argv[1]` only works for a script run by Node; the single-executable has no
 * entrypoint script (Node repeats the binary at argv[1]), so callers must not
 * assemble the pair themselves.
 */
export const resolveSelfInvocation = Effect.fn("nodeRuntime.resolveSelfInvocation")(function* () {
  const command = yield* HostProcessExecutablePath;
  if (yield* HostProcessIsExecutable)
    return { command, entrypoint: undefined } satisfies SelfInvocation;
  const path = yield* Path.Path;
  const entry = (yield* HostProcessArguments)[1];
  // Children spawn from their own working directory, so the script path must be absolute.
  return {
    command,
    entrypoint: entry === undefined ? undefined : path.resolve(entry),
  } satisfies SelfInvocation;
});

/** `[entrypoint?, ...args]`: the argv that runs `args` against this T3 install. */
export const selfInvocationArgs = (
  invocation: SelfInvocation,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  invocation.entrypoint === undefined ? args : [invocation.entrypoint, ...args];

/** A standalone T3 binary runs its embedded CLI, regardless of script arguments. */
export const resolveNodeExecutable = Effect.fn("nodeRuntime.resolveNodeExecutable")(function* (
  feature: typeof NodeRuntimeFeature.Type,
  environment?: NodeJS.ProcessEnv,
) {
  const executablePath = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable)) return executablePath;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const env = environment ?? (yield* HostProcessEnvironment);
  const nodePath = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {
    // Batch wrappers require a shell; helper callers launch the runtime directly.
    env: platform === "win32" ? { ...env, PATHEXT: ".EXE" } : env,
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
  const [hostInfo, nodeInfo] = yield* Effect.all([
    fs.stat(executablePath).pipe(Effect.option),
    fs.stat(nodePath).pipe(Effect.option),
  ]);
  if (
    Option.isSome(hostInfo) &&
    Option.isSome(nodeInfo) &&
    hostInfo.value.dev === nodeInfo.value.dev &&
    Option.isSome(hostInfo.value.ino) &&
    Option.isSome(nodeInfo.value.ino) &&
    Number.isSafeInteger(hostInfo.value.ino.value) &&
    hostInfo.value.ino.value > 0 &&
    hostInfo.value.ino.value === nodeInfo.value.ino.value
  ) {
    return yield* new NodeRuntimeUnavailableError({ feature });
  }
  // Launchers such as Vite+ dispatch by argv[0]; keep the node name intact.
  return nodePath;
});
