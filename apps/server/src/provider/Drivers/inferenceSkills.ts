import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const linkInferenceSkills = Effect.fn("linkInferenceSkills")(function* (
  nativeHome: string | undefined,
  inferenceHome: string,
  privateEntry: string,
) {
  if (nativeHome === inferenceHome) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = nativeHome === undefined ? undefined : path.join(nativeHome, "skills");
  const destination = path.join(inferenceHome, "skills");
  const anchor = path.join(inferenceHome, ".t3-native-skills");
  const linkTarget = (entry: string) =>
    fs.readLink(entry).pipe(Effect.orElseSucceed(() => undefined));
  if ((yield* linkTarget(destination)) !== undefined) return;
  const readNames = (directory: string) =>
    fs
      .readDirectory(directory)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const names = new Set(
    source === undefined
      ? []
      : yield* Effect.filter(
          (yield* readNames(source)).filter(
            (name) => !name.startsWith(".") && name !== privateEntry,
          ),
          (name) => fs.exists(path.join(source, name, "SKILL.md")),
        ),
  );
  const previous = yield* linkTarget(anchor);
  if (!names.size && previous === undefined) return;
  const existing = new Set(yield* readNames(destination));
  for (const name of existing) {
    if (names.has(name)) continue;
    const entry = path.join(destination, name);
    if ((yield* linkTarget(entry)) === path.join(anchor, name)) {
      yield* fs.remove(entry, { force: true });
    }
  }
  if (!names.size || source === undefined) {
    if (previous !== undefined) yield* fs.remove(anchor, { force: true });
    return;
  }
  yield* fs.makeDirectory(destination, { recursive: true, mode: 0o700 });
  if (previous === undefined) {
    yield* fs
      .symlink(source, anchor)
      .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
    if ((yield* linkTarget(anchor)) !== source) return;
  } else if (previous !== source) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stage = yield* fs.makeTempDirectoryScoped({
          directory: inferenceHome,
          prefix: ".t3-skills-",
        });
        const replacement = path.join(stage, "source");
        yield* fs.symlink(source, replacement);
        yield* fs.rename(replacement, anchor);
      }),
    );
  }
  for (const name of names) {
    if (existing.has(name)) continue;
    yield* fs
      .symlink(path.join(anchor, name), path.join(destination, name))
      .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
  }
});
