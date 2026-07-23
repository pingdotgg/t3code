import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererState from "./DesktopRendererState.ts";

function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  return DesktopRendererState.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withRendererState = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopRendererState.DesktopRendererState>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-renderer-state-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopRendererState", () => {
  it.effect("returns none when a renderer state file does not exist", () =>
    withRendererState(
      Effect.gen(function* () {
        const rendererState = yield* DesktopRendererState.DesktopRendererState;

        assert.isTrue(Option.isNone(yield* rendererState.get("ui-state")));
        assert.isTrue(Option.isNone(yield* rendererState.get("composer-preferences")));
      }),
    ),
  );

  it.effect("atomically persists independent raw renderer state documents", () =>
    withRendererState(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const rendererState = yield* DesktopRendererState.DesktopRendererState;
        const uiState = '{"projectOrder":["project-b","project-a"]}';
        const composerPreferences =
          '{"version":1,"stickyModelSelectionByProvider":{},"stickyActiveProvider":"codex"}';

        yield* rendererState.set("ui-state", uiState);
        yield* rendererState.set("composer-preferences", composerPreferences);

        assert.deepEqual(yield* rendererState.get("ui-state"), Option.some(uiState));
        assert.deepEqual(
          yield* rendererState.get("composer-preferences"),
          Option.some(composerPreferences),
        );
        assert.equal(
          yield* fileSystem.readFileString(
            environment.path.join(environment.stateDir, "renderer-state", "ui-state.json"),
          ),
          uiState,
        );
        assert.equal(
          yield* fileSystem.readFileString(
            environment.path.join(
              environment.stateDir,
              "renderer-state",
              "composer-preferences.json",
            ),
          ),
          composerPreferences,
        );
      }),
    ),
  );

  it.effect("removes only the requested renderer state document", () =>
    withRendererState(
      Effect.gen(function* () {
        const rendererState = yield* DesktopRendererState.DesktopRendererState;
        yield* rendererState.set("ui-state", '{"projectOrder":[]}');
        yield* rendererState.set("composer-preferences", '{"state":{},"version":8}');

        yield* rendererState.set("ui-state", null);

        assert.isTrue(Option.isNone(yield* rendererState.get("ui-state")));
        assert.isTrue(Option.isSome(yield* rendererState.get("composer-preferences")));
      }),
    ),
  );
});
