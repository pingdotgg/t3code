import { EnvironmentThemeId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import {
  readPublishedThemes,
  readSettingsObject,
  writeDefaultTheme,
  publishThemeFile,
  resolvableThemeIds,
  ThemeTargetMissingError,
  ThemeFileUnreadableError,
  ThemeIdUnknownError,
  ThemeIdInvalidError,
} from "../environmentTheme.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);

const resolveThemePaths = Effect.fn(function* (explicitBaseDir: Option.Option<string>) {
  const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
  return {
    settingsPath: derivedPaths.settingsPath,
    themesDir: derivedPaths.environmentThemesDir,
  };
});

const themeSetCommand = Command.make("set", {
  baseDir: baseDirFlag,
  id: Flag.String("id").pipe(
    Flag.withDescription("Theme id to publish a file under, instead of its filename."),
    Flag.optional,
  ),
  theme: Argument.String("theme").pipe(
    Argument.withDescription(
      'A theme id (a built-in, or one this machine publishes, where themes/nightfall.json is "nightfall"), or a path to a theme JSON file to publish and set in one step.',
    ),
  ),
}).pipe(
  Command.withDescription("Set the environment's theme; connected clients switch to it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* expandHomePath(flags.theme.trim());
      if (target.length === 0) {
        return yield* new ThemeTargetMissingError();
      }
      const paths = yield* resolveThemePaths(flags.baseDir);

      // A bare theme id must not publish a same-named file that happens to exist in cwd.
      const looksLikePath =
        target.endsWith(".json") ||
        target.includes("/") ||
        target.includes("\\") ||
        target.startsWith("~");
      const targetIsFile =
        looksLikePath && (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)));
      let themeId: string;
      let revertPublish: Effect.Effect<void> = Effect.void;
      let cleanupPublish: Effect.Effect<void> = Effect.void;
      if (targetIsFile) {
        yield* readSettingsObject(paths.settingsPath);
        const published = yield* publishThemeFile({
          themesDir: paths.themesDir,
          filePath: target,
          explicitId: flags.id,
        });
        themeId = published.themeId;
        revertPublish = published.revert;
        cleanupPublish = published.cleanup;
      } else if (looksLikePath) {
        return yield* new ThemeFileUnreadableError({ filePath: target });
      } else if (isEnvironmentThemeId(target)) {
        const known = yield* resolvableThemeIds(paths.themesDir);
        if (!known.includes(target)) {
          return yield* new ThemeIdUnknownError({ themeId: target, known });
        }
        themeId = target;
      } else {
        return yield* new ThemeIdInvalidError({ themeId: target });
      }

      yield* writeDefaultTheme({ settingsPath: paths.settingsPath, themeId }).pipe(
        Effect.onError(() => revertPublish),
      );
      yield* cleanupPublish;
      yield* Console.log(
        targetIsFile
          ? `Published ${target} as "${themeId}" and set it as the environment theme.\n`
          : `Environment theme set to "${themeId}" in ${paths.settingsPath}.\n`,
      );
    }),
  ),
);

const themeClearCommand = Command.make("clear", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Remove the environment's theme; clients keep what they have."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const paths = yield* resolveThemePaths(flags.baseDir);
      yield* writeDefaultTheme({ settingsPath: paths.settingsPath, themeId: "" });
      yield* Console.log(`Environment theme cleared in ${paths.settingsPath}.\n`);
    }),
  ),
);

const themeShowCommand = Command.make("show", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show the environment's theme and its published themes."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const paths = yield* resolveThemePaths(flags.baseDir);
      const { settings } = yield* readSettingsObject(paths.settingsPath);
      const defaultTheme =
        typeof settings.defaultTheme === "string" && settings.defaultTheme.length > 0
          ? settings.defaultTheme
          : null;

      const published = (yield* readPublishedThemes(paths.themesDir))
        .map((theme) => theme.id)
        .toSorted();

      yield* Console.log(
        defaultTheme === null
          ? "Environment theme: not set.\n"
          : `Environment theme: "${defaultTheme}".\n`,
      );
      yield* Console.log(
        published.length === 0
          ? `Published themes: none (publish into ${paths.themesDir}).\n`
          : `Published themes: ${published.join(", ")}.\n`,
      );
    }),
  ),
);

export const themeCommand = Command.make("theme").pipe(
  Command.withDescription("Inspect and set environment-wide theme defaults."),
  Command.withSubcommands([themeSetCommand, themeClearCommand, themeShowCommand]),
);
