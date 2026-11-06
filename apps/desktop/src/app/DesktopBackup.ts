import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const backupOnce = Effect.fn("desktop.backupOnce")(function* (
  fileSystem: FileSystem.FileSystem,
  originalPath: string,
  backupPath: string,
) {
  if (Option.isSome(yield* fileSystem.readFile(backupPath).pipe(Effect.option))) return;
  const original = yield* fileSystem.readFile(originalPath);
  yield* fileSystem.writeFile(backupPath, original, { flag: "wx" }).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "AlreadyExists",
      () => Effect.void,
    ),
  );
});
