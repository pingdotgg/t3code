import { ThemePaletteConfig, type ThemePaletteDefinition } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ServerConfig, type ServerConfigShape } from "./config";
import { Themes, ThemesLive } from "./themes";

const ThemePaletteConfigJson = Schema.fromJsonString(ThemePaletteConfig);

const makeThemesLayer = () =>
  ThemesLive.pipe(
    Layer.provideMerge(
      Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { join } = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-themes-test-" });
          const configPath = join(dir, "themes.json");
          return { themesConfigPath: configPath } as ServerConfigShape;
        }),
      ),
    ),
  );

const writeThemesConfig = (configPath: string, themes: readonly ThemePaletteDefinition[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(ThemePaletteConfigJson)(themes);
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readThemesConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* Schema.decodeUnknownEffect(ThemePaletteConfigJson)(rawConfig);
  });

it.layer(NodeServices.layer)("themes", (it) => {
  it.effect("bootstraps an empty themes config when the file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { themesConfigPath } = yield* ServerConfig;
      assert.isFalse(yield* fs.exists(themesConfigPath));

      yield* Effect.gen(function* () {
        const themes = yield* Themes;
        yield* themes.syncDefaultThemesOnStartup;
      });

      const persisted = yield* readThemesConfig(themesConfigPath);
      assert.deepEqual(persisted, []);
    }).pipe(Effect.provide(makeThemesLayer())),
  );

  it.effect("reports malformed config while falling back to no custom themes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { themesConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(themesConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const themes = yield* Themes;
        return yield* themes.loadConfigState;
      });

      assert.deepEqual(configState.themes, []);
      assert.deepEqual(configState.issues, [
        {
          kind: "themes.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(themesConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeThemesLayer())),
  );

  it.effect("keeps valid custom themes and reports invalid entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { themesConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        themesConfigPath,
        JSON.stringify([
          {
            id: "midnight-mint",
            label: "Midnight Mint",
            dark: {
              background: "oklch(0.17 0.02 220)",
              primary: "oklch(0.79 0.16 170)",
            },
          },
          {
            id: "Invalid Id",
            label: "Broken",
          },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const themes = yield* Themes;
        return yield* themes.loadConfigState;
      });

      assert.deepEqual(configState.themes, [
        {
          id: "midnight-mint",
          label: "Midnight Mint",
          dark: {
            background: "oklch(0.17 0.02 220)",
            primary: "oklch(0.79 0.16 170)",
          },
        },
      ]);
      assert.deepEqual(configState.issues, [
        {
          kind: "themes.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeThemesLayer())),
  );

  it.effect("persists valid custom themes without mutation", () =>
    Effect.gen(function* () {
      const { themesConfigPath } = yield* ServerConfig;
      yield* writeThemesConfig(themesConfigPath, [
        {
          id: "aurora",
          label: "Aurora",
          light: {
            primary: "oklch(0.61 0.17 210)",
          },
        },
      ]);

      const configState = yield* Effect.gen(function* () {
        const themes = yield* Themes;
        return yield* themes.loadConfigState;
      });

      assert.deepEqual(configState.themes, [
        {
          id: "aurora",
          label: "Aurora",
          light: {
            primary: "oklch(0.61 0.17 210)",
          },
        },
      ]);
      assert.deepEqual(configState.issues, []);
    }).pipe(Effect.provide(makeThemesLayer())),
  );
});
