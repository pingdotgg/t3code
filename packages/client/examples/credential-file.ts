import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Reserves an owner-only file before creating the credential, refusing existing paths. */
export const writeCredentialFile = Effect.fn("example.writeCredentialFile")(function* <E, R>(
  path: string,
  encoded: Effect.Effect<string, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  let reserved = false;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "wx", mode: 0o600 });
      reserved = true;
      yield* file.writeAll(new TextEncoder().encode(yield* encoded));
    }),
  ).pipe(
    Effect.onError(() =>
      reserved ? fs.remove(path).pipe(Effect.ignore({ log: true })) : Effect.void,
    ),
  );
});
