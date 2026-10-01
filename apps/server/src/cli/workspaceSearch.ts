import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

// Load the native index only in the worker process, including standalone installs.
export const workspaceSearchCommand = Command.make("__workspace-search").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.promise(async () => {
      const { runWorkspaceSearchWorker } = await import("../workspaceSearchWorker.ts");
      runWorkspaceSearchWorker();
    }).pipe(Effect.andThen(Effect.never)),
  ),
);
