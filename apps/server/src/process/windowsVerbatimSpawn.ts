// @effect-diagnostics nodeBuiltinImport:off - Effect's spawner has no windowsVerbatimArguments option.
import * as NodeChildProcess from "node:child_process";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type WindowsVerbatimSpawner = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, Error>;

/** Succeeds once a detached child has started and no longer holds this process open; fails if it cannot start. */
export const awaitDetachedSpawn = (spawn: () => NodeChildProcess.ChildProcess) =>
  Effect.callback<void, Error>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = spawn();
    } catch (error) {
      resume(Effect.fail(error instanceof Error ? error : new Cause.UnknownError(error)));
      return;
    }
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
  });

const spawnDetachedVerbatim: WindowsVerbatimSpawner = (command, args) =>
  awaitDetachedSpawn(() =>
    NodeChildProcess.spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }),
  );

export const WindowsVerbatimSpawn = Context.Reference<WindowsVerbatimSpawner>(
  "t3/process/WindowsVerbatimSpawn",
  { defaultValue: () => spawnDetachedVerbatim },
);
