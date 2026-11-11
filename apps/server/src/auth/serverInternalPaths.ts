// @effect-diagnostics nodeBuiltinImport:off - Effect's realPath keeps the requested letter case.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

/** Builds a check for the server's own state files, which client file reads do not serve. */
export const makeIsServerInternalPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // Native realpath returns the on-disk letter case.
  const realPath = (value: string) =>
    Effect.promise(() => NodeFSP.realpath(value).catch(() => path.resolve(value)));
  return Effect.fn("ServerInternalPaths.isServerInternalPath")(function* (filePath: string) {
    const [file, stateDir, secretsDir] = yield* Effect.all(
      [realPath(filePath), realPath(config.stateDir), realPath(config.secretsDir)],
      { concurrency: "unbounded" },
    );
    return (
      isWithinRoot(path, file, secretsDir) ||
      (path.dirname(file) === stateDir && path.basename(file).includes(".sqlite")) ||
      // macOS does not resolve `/dev/fd/N` to the open file's path.
      isWithinRoot(path, file, "/dev/fd")
    );
  });
});
