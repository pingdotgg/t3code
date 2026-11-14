// @effect-diagnostics nodeBuiltinImport:off - Effect's spawner has no windowsVerbatimArguments option.
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type WindowsVerbatimSpawner = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, Error>;

const spawnDetachedVerbatim: WindowsVerbatimSpawner = (command, args) =>
  Effect.callback<void, Error>((resume) => {
    const child = NodeChildProcess.spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
  });

export const WindowsVerbatimSpawn = Context.Reference<WindowsVerbatimSpawner>(
  "t3/process/WindowsVerbatimSpawn",
  { defaultValue: () => spawnDetachedVerbatim },
);
