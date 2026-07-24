import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Permissions are the whole security model here: the file lives inside the
// server's own state dir and is only readable by its owner, so a same-user
// local client that can read it is already as trusted as the desktop child
// that gets its bootstrap token over fd3.
const LOCAL_ATTACH_TOKEN_MODE = 0o600;

export class LocalAttachTokenFileError extends Schema.TaggedErrorClass<LocalAttachTokenFileError>()(
  "LocalAttachTokenFileError",
  {
    operation: Schema.Literals(["write", "clear"]),
    tokenPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} local attach token file at ${this.tokenPath}.`;
  }
}

// Publishes the token through a mode-0600 temporary file in the target
// directory, then atomically renames it into place. The administrative token
// is therefore never visible through the stable path with permissions inherited
// from a pre-existing file.
export const writeLocalAttachTokenFile = (input: {
  readonly path: string;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetDirectory = path.dirname(input.path);
    yield* fs.makeDirectory(targetDirectory, { recursive: true });
    const tempDirectory = yield* fs.makeTempDirectoryScoped({
      directory: targetDirectory,
      prefix: `${path.basename(input.path)}.`,
    });
    const tempPath = path.join(tempDirectory, "token.tmp");
    yield* fs.writeFileString(tempPath, `${input.token}\n`, {
      mode: LOCAL_ATTACH_TOKEN_MODE,
    });
    yield* fs.chmod(tempPath, LOCAL_ATTACH_TOKEN_MODE);
    yield* fs.rename(tempPath, input.path);
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new LocalAttachTokenFileError({ operation: "write", tokenPath: input.path, cause }),
    ),
  );

// Removes the token file on graceful shutdown, alongside server-runtime.json.
// A missing file is not an error; other failures are logged and swallowed so
// shutdown finalizers can't fail the release.
export const clearLocalAttachTokenFile = (tokenPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tokenPath, { force: true }).pipe(
      Effect.mapError(
        (cause) => new LocalAttachTokenFileError({ operation: "clear", tokenPath, cause }),
      ),
      Effect.catchTags({
        LocalAttachTokenFileError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              tokenPath: error.tokenPath,
              cause: error,
            }),
          ),
      }),
    );
  });
