import { EnvironmentThemeFile } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

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

  it.effect("never replays a set older than the snapshot it started from", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        yield* currentThemes;
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["shared-light"],
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
        "ocean.json": encodeThemeFile(SHARED_THEME),
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

  it.effect.skipIf(!symlinksSupported)("ignores a symlinked theme file", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(environmentThemesDir, "..", "outside.json");
        yield* fs.writeFileString(outside, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.symlink(outside, path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("does not charge skipped files against the total size limit", () =>
    withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [`junk-${index}.json`, "{".repeat(30_000)]),
        ),
        "zz-valid.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["zz-valid"],
        );
      }),
    ),
  );
});

// Kept outside the it.layer block above because only the top-level `it` exposes
// `live`.
describe("environment theme watching", () => {
  it.live("streams a set for every change to the directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-watch-" });
      const themesDir = path.join(baseDir, "userdata", "themes");
      yield* fs.makeDirectory(themesDir, { recursive: true });

      yield* Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);

        assert.deepEqual(yield* Queue.take(seen), []);

        const staging = path.join(baseDir, "staged.json");
        yield* fs.writeFileString(staging, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.rename(staging, path.join(themesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["nightfall"],
        );

        yield* fs.remove(path.join(themesDir, "nightfall.json"));
        assert.deepEqual(yield* Queue.take(seen), []);
      }).pipe(
        Effect.provide(
          EnvironmentTheme.layer.pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
        Effect.timeout("30 seconds"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
