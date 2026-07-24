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

// Rewrites the token file each boot (single line, token only) and forces
// mode 0600 even if a prior boot left it with looser permissions.
export const writeLocalAttachTokenFile = (input: {
  readonly path: string;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(input.path), { recursive: true });
    yield* fs.writeFileString(input.path, `${input.token}\n`, {
      mode: LOCAL_ATTACH_TOKEN_MODE,
    });
    // `mode` on open only applies when the file is created, so chmod
    // unconditionally to tighten a file that already existed.
    yield* fs.chmod(input.path, LOCAL_ATTACH_TOKEN_MODE);
  }).pipe(
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
      Effect.catchTag("LocalAttachTokenFileError", (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            tokenPath: error.tokenPath,
            cause: error,
          }),
        ),
      ),
    );
  });
