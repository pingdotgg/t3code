import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class AntigravityCredentialsError extends Schema.TaggedError<AntigravityCredentialsError>()(
  "AntigravityCredentialsError",
  {
    operation: Schema.Literals(["recover", "isolate", "discardBackup"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not update saved Antigravity credentials.";
  }
}

export class AntigravityCredentials extends Context.Service<
  AntigravityCredentials,
  {
    readonly recover: Effect.Effect<void, AntigravityCredentialsError>;
    readonly discardBackup: Effect.Effect<void, AntigravityCredentialsError>;
    readonly withFreshSignIn: <A, E, R>(
      task: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AntigravityCredentialsError, R>;
  }
>()("t3/provider/AntigravityCredentials") {}

const make = Effect.fn("AntigravityCredentials.make")(function* (profileDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "acp_token.json");
  const backupPath = `${tokenPath}.before-sign-in`;
  const discardBackup = fs.remove(backupPath, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityCredentialsError({
          operation: "discardBackup",
          path: backupPath,
          cause,
        }),
    ),
  );
  const recover = Effect.gen(function* () {
    if (!(yield* fs.exists(backupPath))) return;
    // Both names share a directory. A hard link installs atomically without replacing a native writer.
    yield* fs.link(backupPath, tokenPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
      }),
    );
    yield* fs.remove(backupPath, { force: true });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AntigravityCredentialsError({
          operation: "recover",
          path: tokenPath,
          cause,
        }),
    ),
  );
  const withFreshSignIn: AntigravityCredentials["Service"]["withFreshSignIn"] = (task) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Settle a previous failed cleanup before its backup name can be reused.
        yield* recover;
        yield* Effect.gen(function* () {
          if (yield* fs.exists(tokenPath)) yield* fs.rename(tokenPath, backupPath);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AntigravityCredentialsError({
                operation: "isolate",
                path: tokenPath,
                cause,
              }),
          ),
        );
        const result = yield* restore(task).pipe(Effect.exit);
        // Fresh credentials win even when authentication or model discovery subsequently fails.
        yield* recover;
        return yield* result;
      }),
    );
  return AntigravityCredentials.of({ recover, discardBackup, withFreshSignIn });
});

export const layer = (profileDirectory: string) =>
  Layer.effect(AntigravityCredentials, make(profileDirectory));
