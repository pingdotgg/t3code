import { EnvironmentThemeFile } from "@t3tools/contracts";
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
  it.effect(
    "publishes CRUD changes without implicitly applying, and protects defaults and built-ins",
    () =>
      withEnvironmentThemes(
        {},
        Effect.gen(function* () {
          const service = yield* EnvironmentTheme.EnvironmentThemeService;
          const fs = yield* FileSystem.FileSystem;
          const { settingsPath } = yield* ServerConfig.ServerConfig;
          const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
          yield* Stream.runForEach(service.streamChanges, (themes) =>
            Queue.offer(seen, themes),
          ).pipe(Effect.forkScoped);
          assert.deepEqual(yield* Queue.take(seen), []);
          yield* service.save({ id: "nightfall", theme: NIGHTFALL_THEME, overwrite: false });
          assert.deepEqual(
            (yield* Queue.take(seen)).map((theme) => theme.id),
            ["nightfall"],
          );
          assert.equal(yield* fs.exists(settingsPath), false);
          const partial = {
            version: 1 as const,
            name: "Partial",
            appearance: "dark" as const,
            colors: { accent: "#abcdef" },
            variants: { light: { accent: "#123456" } },
          };
          yield* service.save({ id: "nightfall", theme: partial, overwrite: true });
          assert.deepEqual(yield* service.read("nightfall"), { id: "nightfall", ...partial });
          yield* service.duplicate({ sourceId: "ocean", id: "ocean-copy", name: "My Ocean" });
          assert.deepEqual(
            (yield* service.read("ocean-copy")).colors,
            (yield* service.read("ocean")).colors,
          );
          yield* service.setDefault("nightfall");
          const before = yield* fs.readFileString(settingsPath);
          yield* service.save({ id: "nightfall", theme: partial, overwrite: true });
          assert.equal(yield* fs.readFileString(settingsPath), before);
          assert.equal((yield* Effect.flip(service.remove("nightfall"))).reason, "default_in_use");
          assert.equal((yield* Effect.flip(service.remove("ocean"))).reason, "builtin");
          assert.equal(
            (yield* Effect.flip(service.save({ id: "ocean", theme: partial, overwrite: true })))
              .reason,
            "builtin",
          );
          yield* service.setDefault("");
          assert.equal(
            (yield* EnvironmentTheme.readSettingsObject(settingsPath)).settings.defaultTheme,
            undefined,
          );
          yield* service.remove("nightfall");
          assert.equal((yield* Effect.flip(service.read("nightfall"))).reason, "not_found");
        }),
      ),
  );

  it.effect(
    "serializes colliding creates and rejects invalid and oversized definitions without changing files",
    () =>
      withEnvironmentThemes(
        {},
        Effect.gen(function* () {
          const service = yield* EnvironmentTheme.EnvironmentThemeService;
          const results = yield* Effect.all(
            [
              service
                .save({ id: "same", theme: NIGHTFALL_THEME, overwrite: false })
                .pipe(Effect.result),
              service
                .save({ id: "same", theme: SHARED_THEME, overwrite: false })
                .pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(results.filter((result) => result._tag === "Success").length, 1);
          assert.equal((yield* service.current).length, 1);
          assert.equal(
            (yield* Effect.flip(
              service.save({ id: "../escape", theme: NIGHTFALL_THEME, overwrite: false }),
            )).reason,
            "invalid",
          );
          assert.equal(
            (yield* Effect.flip(
              service.save({
                id: "empty",
                theme: { name: "Empty", appearance: "dark" },
                overwrite: false,
              }),
            )).reason,
            "invalid",
          );
          assert.equal(
            (yield* Effect.flip(
              service.save({
                id: "invalid-color",
                theme: { ...SHARED_THEME, variants: { light: { accent: "var(--secret)" } } },
                overwrite: false,
              }),
            )).reason,
            "invalid",
          );
          const colors = Object.fromEntries(
            Array.from({ length: 600 }, (_, i) => [`color${i}`, "#123456".repeat(8)]),
          );
          assert.equal(
            (yield* Effect.flip(
              service.save({
                id: "large",
                theme: { name: "Large", appearance: "dark", colors },
                overwrite: false,
              }),
            )).reason,
            "invalid",
          );
          assert.equal((yield* service.current).length, 1);
        }),
      ),
  );

  it.effect.each([
    { count: 32, bytes: 0 },
    { count: 6, bytes: 32 * 1024 },
  ])("rejects capacity overflow without hiding an existing theme (%j)", ({ count, bytes }) =>
    withEnvironmentThemes(
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `theme-${i}.json`,
          encodeThemeFile(NIGHTFALL_THEME).padEnd(bytes, " "),
        ]),
      ),
      Effect.gen(function* () {
        const service = yield* EnvironmentTheme.EnvironmentThemeService;
        assert.equal(
          (yield* Effect.flip(
            service.save({ id: "aaa", theme: NIGHTFALL_THEME, overwrite: false }),
          )).reason,
          "storage",
        );
        assert.equal((yield* service.current).length, count);
        assert.equal((yield* Effect.flip(service.read("aaa"))).reason, "not_found");
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
        const service = yield* EnvironmentTheme.EnvironmentThemeService;
        assert.equal(
          (yield* Effect.flip(
            service.save({ id: "nightfall", theme: NIGHTFALL_THEME, overwrite: false }),
          )).reason,
          "collision",
        );
        assert.equal(
          (yield* Effect.flip(
            service.save({ id: "nightfall", theme: NIGHTFALL_THEME, overwrite: true }),
          )).reason,
          "invalid",
        );
        assert.equal(yield* fs.readFileString(outside), encodeThemeFile(NIGHTFALL_THEME));
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
