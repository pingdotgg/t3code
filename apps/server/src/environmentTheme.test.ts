import { EnvironmentThemeFile } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

/** The standard exported form: a full palette, no seeds. */
const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

/** Seeds theme files before the service starts, as a real machine would. */
const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      yield* fs.writeFileString(path.join(themesDir, filename), contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

it.layer(NodeServices.layer)("environment theme", (it) => {
  it.effect("publishes nothing when the machine has no theme files", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("publishes each file under its filename as the id", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "shared-light.json": encodeThemeFile(SHARED_THEME),
      },
      Effect.gen(function* () {
        const themes = yield* currentThemes;
        assert.deepEqual(
          themes.map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
        assert.deepEqual(themes[0], { id: "nightfall", ...NIGHTFALL_THEME });
        assert.deepEqual(themes[1], { id: "shared-light", ...SHARED_THEME });
      }),
    ),
  );

  // Read from disk rather than from the watcher's last observation, so a
  // client connecting after a missed filesystem event still sees the truth.
  it.effect("follows the directory rather than the set read at start", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        assert.equal((yield* currentThemes).length, 2);

        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  // One bad file must not take down the machine's other themes: a theme
  // script that leaves a template placeholder unresolved, a half-written
  // file, or a stray name are each that file's problem alone.
  // The subscription is acquired before the current set is read, so nothing
  // published while a client connects can fall between snapshot and stream.
  it.effect("streams the current set first", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const first = yield* environmentTheme.streamChanges.pipe(Stream.runHead);
        assert.deepEqual(Option.getOrNull(first), [{ id: "nightfall", ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  // Subscribing happens before the snapshot read, so a publish landing in
  // between is queued. It must not replay after the newer snapshot and walk
  // clients back onto colors the machine has already moved past.
  it.effect("never replays a set older than the snapshot it started from", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Advance the directory twice without the watcher running, so the
        // second read is strictly newer than anything already observed.
        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        const first = yield* environmentTheme.streamChanges.pipe(Stream.runHead);
        assert.deepEqual(
          Option.getOrNull(first)?.map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
      }),
    ),
  );

  it.effect("skips invalid files while keeping valid ones", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "unresolved.json":
          '{ "name": "X", "appearance": "dark", "canvas": "{{ background }}", "accent": "#7aa2f7" }',
        "malformed.json": "{ not json",
        "no-colors.json": '{ "name": "Empty", "appearance": "dark" }',
        "Bad Name.json": encodeThemeFile(SHARED_THEME),
        "dark.json": encodeThemeFile(SHARED_THEME),
        "notes.txt": "not a theme",
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["nightfall"],
        );
      }),
    ),
  );
});
