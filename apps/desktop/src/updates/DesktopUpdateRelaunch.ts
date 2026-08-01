import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const UPDATE_RELAUNCH_MARKER_FILE_NAME = "desktop-update-relaunch";

const markerPath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return environment.path.join(environment.stateDir, UPDATE_RELAUNCH_MARKER_FILE_NAME);
});

export const mark = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  yield* fileSystem.writeFileString(
    environment.path.join(environment.stateDir, UPDATE_RELAUNCH_MARKER_FILE_NAME),
    "pending\n",
  );
}).pipe(Effect.withSpan("desktop.updateRelaunch.mark"));

export const clear = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* markerPath;
  if (yield* fileSystem.exists(path)) {
    yield* fileSystem.remove(path);
  }
}).pipe(Effect.withSpan("desktop.updateRelaunch.clear"));

export const consume = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* markerPath;
  if (!(yield* fileSystem.exists(path))) {
    return false;
  }
  yield* fileSystem.remove(path);
  return true;
}).pipe(Effect.withSpan("desktop.updateRelaunch.consume"));
