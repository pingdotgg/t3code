// @effect-diagnostics nodeBuiltinImport:off - Effect's realPath keeps the requested letter case.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

/** Checks a path against the server's own state files and returns the native resolution checked. */
export const makeCheckServerInternalPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // Native realpath returns the on-disk letter case.
  const realPath = (value: string) =>
    Effect.promise(() => NodeFSP.realpath(value).catch(() => undefined));
  return Effect.fn("ServerInternalPaths.isServerInternalPath")(function* (filePath: string) {
    const [canonicalPath, canonicalStateDir, canonicalSecretsDir] = yield* Effect.all(
      [realPath(filePath), realPath(config.stateDir), realPath(config.secretsDir)],
      { concurrency: "unbounded" },
    );
    const file = canonicalPath ?? path.resolve(filePath);
    const stateDir = canonicalStateDir ?? path.resolve(config.stateDir);
    const secretsDir = canonicalSecretsDir ?? path.resolve(config.secretsDir);
    const isInternal =
      isWithinRoot(path, file, secretsDir) ||
      (path.dirname(file) === stateDir && path.basename(file).includes(".sqlite")) ||
      // macOS does not resolve `/dev/fd/N` to the open file's path.
      isWithinRoot(path, file, "/dev/fd");
    return { isInternal, canonicalPath };
  });
});

/** Builds a check for the server's own state files, which client file reads do not serve. */
export const makeIsServerInternalPath = Effect.map(
  makeCheckServerInternalPath,
  (check) => (filePath: string) => check(filePath).pipe(Effect.map(({ isInternal }) => isInternal)),
);
