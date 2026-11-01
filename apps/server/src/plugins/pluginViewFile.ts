// @effect-diagnostics nodeBuiltinImport:off -- Refusing FIFO swaps requires O_NONBLOCK, unavailable through Effect FileSystem.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";

const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

export const open = Effect.fn("PluginViews.openFile")(function* (path: string) {
  const file = yield* Effect.acquireRelease(
    Effect.tryPromise(() => NodeFSP.open(path, OPEN_FLAGS)),
    (file) => Effect.promise(() => file.close()),
  );
  return {
    stat: Effect.tryPromise(() => file.stat()),
    read: (buffer: Uint8Array) =>
      Effect.tryPromise(async () => (await file.read(buffer)).bytesRead),
  };
});

export type ViewFile = Effect.Success<ReturnType<typeof open>>;
