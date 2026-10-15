import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Creates a new owner-only credential file. Fails if `path` already exists, so
 * token bytes never land in a file with looser permissions or behind a symlink.
 */
export const writeCredentialFile = Effect.fn("example.writeCredentialFile")(function* (
  path: string,
  encoded: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, encoded, { flag: "wx", mode: 0o600 });
});
