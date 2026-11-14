import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentThemeFile,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { ServerSettingsService } from "./serverSettings.ts";
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

/** The settings mock refuses to make this theme the default, as a managed policy can. */
const REFUSED_THEME_ID = "refused";

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
  /** Receives each theme and appearance the service makes the environment default. */
  selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [],
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
          Layer.provideMerge(
            Layer.mock(ServerSettingsService)({
              updateSettings: (patch) =>
                patch.defaultTheme === REFUSED_THEME_ID
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "settings.json",
                        operation: "write-managed-setting",
                      }),
                    )
                  : Effect.sync(() => {
                      selected.push({
                        ...(patch.defaultTheme === undefined ? {} : { theme: patch.defaultTheme }),
                        ...(patch.defaultAppearance === undefined
                          ? {}
                          : { appearance: patch.defaultAppearance }),
                      });
                      return DEFAULT_SERVER_SETTINGS;
                    }),
            }),
          ),
        ),
      ),
    );
  });

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

it.layer(NodeServices.layer)("environment theme", (it) => {
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
        "notepad.json": `\uFEFF${encodeThemeFile(SHARED_THEME)}`,
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
          ["nightfall", "notepad"],
        );
      }),
    ),
  );

  it.effect("puts the previous theme back when the new one cannot be selected", () =>
    withEnvironmentThemes(
      { [`${REFUSED_THEME_ID}.json`]: encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const refused = yield* themes
          .apply({ themeId: REFUSED_THEME_ID, theme: { ...NIGHTFALL_THEME, name: "Changed" } })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "EnvironmentThemeNotSelectedError");
        assert.deepEqual(yield* themes.current, [{ id: REFUSED_THEME_ID, ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  it.effect("does not replace a theme file it could not put back", () => {
    const oversized = JSON.stringify({ ...NIGHTFALL_THEME, padding: "x".repeat(40_000) });
    return withEnvironmentThemes(
      { [`${REFUSED_THEME_ID}.json`]: oversized },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const refused = yield* themes
          .apply({ themeId: REFUSED_THEME_ID, theme: NIGHTFALL_THEME })
          .pipe(Effect.flip);
        assert.match(refused.message, /could not be backed up/);
        assert.strictEqual(
          yield* fs.readFileString(`${config.environmentThemesDir}/${REFUSED_THEME_ID}.json`),
          oversized,
        );
      }),
    );
  });

  it.effect.skipIf(!symlinksSupported)("does not write through a symlink at its staging path", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const outside = path.join(environmentThemesDir, "..", "outside.txt");
        yield* fs.writeFileString(outside, "keep");
        yield* fs.symlink(
          outside,
          path.join(environmentThemesDir, `look.json.staging-${process.pid}`),
        );

        yield* themes.apply({ themeId: "look", theme: NIGHTFALL_THEME });
        assert.strictEqual(yield* fs.readFileString(outside), "keep");
        assert.deepEqual(yield* themes.current, [{ id: "look", ...NIGHTFALL_THEME }]);
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

  it.effect("publishes and selects a theme, and refuses unsafe CSS and unknown ids", () => {
    const selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [];
    return withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        // A comment may name an address. Only a rule that loads one is refused.
        const css =
          "/* from url(https://example.com/guide) */ [data-chat-header] { border-bottom: 1px solid red; }";
        yield* themes.apply({ themeId: "agent-look", theme: { ...NIGHTFALL_THEME, css } });
        assert.deepEqual(yield* themes.current, [{ id: "agent-look", ...NIGHTFALL_THEME, css }]);

        const leaky = yield* themes
          .apply({
            themeId: "leaky",
            theme: {
              ...NIGHTFALL_THEME,
              css: 'input[value^="a"] { background: url(https://example.com/a); }',
            },
          })
          .pipe(Effect.flip);
        assert.match(leaky.message, /loads files/);
        const reserved = yield* themes
          .apply({ themeId: "dark", theme: NIGHTFALL_THEME })
          .pipe(Effect.flip);
        assert.match(reserved.message, /not a valid theme id/);
        const unknown = yield* themes.apply({ themeId: "missing" }).pipe(Effect.flip);
        assert.match(unknown.message, /not a built-in or published theme/);
        yield* themes.apply({ themeId: "grove" });
        yield* themes.apply({ themeId: "grove", appearance: "dark" });
        yield* themes.apply({ appearance: "light" });

        assert.deepEqual(
          (yield* themes.current).map((theme) => theme.id),
          ["agent-look"],
        );
        // Only a theme that was published or already exists becomes the environment theme.
        assert.deepEqual(selected, [
          { theme: "agent-look" },
          { theme: "grove" },
          { theme: "grove", appearance: "dark" },
          { appearance: "light" },
        ]);
      }),
      selected,
    );
  });

  it.effect("keeps the served theme when an update does not fit the size limit", () => {
    const large = (name: string): EnvironmentThemeFile => ({
      ...NIGHTFALL_THEME,
      name,
      css: `/* ${"x".repeat(19_900)} */`,
    });
    return withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `aa-${index}.json`,
            encodeThemeFile(large(`Large ${index}`)),
          ]),
        ),
        "zz-look.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const served = Effect.map(themes.current, (all) =>
          all.find((theme) => theme.id === "zz-look"),
        );
        assert.deepEqual(yield* served, { id: "zz-look", ...NIGHTFALL_THEME });

        const refused = yield* themes
          .apply({ themeId: "zz-look", theme: large("Too much") })
          .pipe(Effect.flip);
        assert.match(refused.message, /could not be published/);
        assert.deepEqual(yield* served, { id: "zz-look", ...NIGHTFALL_THEME });

        // A new theme that sorts first fits, and the last large one no longer does.
        const before = (yield* themes.current).map((theme) => theme.id);
        const displacing = yield* themes
          .apply({ themeId: "a0-first", theme: large("Displacing") })
          .pipe(Effect.flip);
        assert.match(displacing.message, /could not be published/);
        assert.deepEqual(
          (yield* themes.current).map((theme) => theme.id),
          before,
        );
      }),
    );
  });

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
