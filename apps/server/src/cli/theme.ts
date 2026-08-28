/**
 * `t3 theme` - inspect and set the environment's theme. Connected web and
 * desktop clients switch when it is set; mobile keeps its own appearance
 * settings. Each client applies one set once, so a theme the user picks in
 * Settings afterwards sticks until the next `t3 theme set`.
 *
 * Writes `defaultTheme` (and `defaultThemeSetAt`, so a re-set of the same
 * value still acts) into the environment's `settings.json`. A running server
 * watches that file and pushes the change, so this works before the first
 * launch and on a live server alike.
 *
 * The edit is deliberately a minimal one on the parsed JSON object rather than
 * a schema round-trip. Settings files outlive the build that reads them, and a
 * provisioning command must not drop keys this version does not recognise.
 */
import {
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { BUILT_IN_THEME_IDS, UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import {
  MAX_THEME_FILE_BYTES,
  readPublishedThemes,
  readThemeFileGuarded,
} from "../environmentTheme.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

/** Settings files outlive the build that reads them, so the object is carried
 * as-is and only the theme keys are touched. */
const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));
const decodeThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

export class ThemeSettingsUnreadableError extends Schema.TaggedErrorClass<ThemeSettingsUnreadableError>()(
  "ThemeSettingsUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix its permissions, then run this again.`;
  }
}

export class ThemeSettingsMalformedError extends Schema.TaggedErrorClass<ThemeSettingsMalformedError>()(
  "ThemeSettingsMalformedError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.settingsPath} is not a JSON object. Fix or remove it, then run this again.`;
  }
}

export class ThemeSettingsBusyError extends Schema.TaggedErrorClass<ThemeSettingsBusyError>()(
  "ThemeSettingsBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing (gave up after ${this.attempts} attempts). Try again.`;
  }
}

export class ThemeSettingsWriteError extends Schema.TaggedErrorClass<ThemeSettingsWriteError>()(
  "ThemeSettingsWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

export class ThemeFileUnreadableError extends Schema.TaggedErrorClass<ThemeFileUnreadableError>()(
  "ThemeFileUnreadableError",
  // Optional: a path that never existed has no underlying failure to carry,
  // and a manufactured string there would only look like a real one.
  { filePath: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read ${this.filePath}.`;
  }
}

export class ThemeFileInvalidError extends Schema.TaggedErrorClass<ThemeFileInvalidError>()(
  "ThemeFileInvalidError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.filePath} is not a valid theme file. Use a theme exported from T3 Code, or a seeded file with name, appearance, canvas, and accent.`;
  }
}

export class ThemeFileTooLargeError extends Schema.TaggedErrorClass<ThemeFileTooLargeError>()(
  "ThemeFileTooLargeError",
  { filePath: Schema.String, limit: Schema.Number },
) {
  override get message(): string {
    return `${this.filePath} is larger than ${this.limit} bytes, which is more than a theme can publish.`;
  }
}

export class ThemeFileColorlessError extends Schema.TaggedErrorClass<ThemeFileColorlessError>()(
  "ThemeFileColorlessError",
  { filePath: Schema.String },
) {
  override get message(): string {
    return `${this.filePath} has no colors to publish.`;
  }
}

export class ThemePublishError extends Schema.TaggedErrorClass<ThemePublishError>()(
  "ThemePublishError",
  { themesDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not publish the theme into ${this.themesDir}.`;
  }
}

const INVALID_THEME_ID_REASON =
  "is not a valid theme id (lowercase letters, digits, and hyphens; not an appearance keyword)";

export class ThemeIdUnknownError extends Schema.TaggedErrorClass<ThemeIdUnknownError>()(
  "ThemeIdUnknownError",
  { themeId: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `No theme named "${this.themeId}". Available: ${this.known.join(", ")}. Publish one by passing a theme file instead of an id.`;
  }
}

export class ThemeIdInvalidError extends Schema.TaggedErrorClass<ThemeIdInvalidError>()(
  "ThemeIdInvalidError",
  { themeId: Schema.String },
) {
  override get message(): string {
    return `"${this.themeId}" ${INVALID_THEME_ID_REASON}.`;
  }
}

/** A filename that cannot be a theme id, where --id is the way out. */
export class ThemeFileIdInvalidError extends Schema.TaggedErrorClass<ThemeFileIdInvalidError>()(
  "ThemeFileIdInvalidError",
  { themeId: Schema.String, filePath: Schema.String },
) {
  override get message(): string {
    return `"${this.themeId}" ${INVALID_THEME_ID_REASON}. Pass one with --id.`;
  }
}

export class ThemeTargetMissingError extends Schema.TaggedErrorClass<ThemeTargetMissingError>()(
  "ThemeTargetMissingError",
  {},
) {
  override get message(): string {
    return "Provide a theme id or file, or run `t3 theme clear` to remove the theme.";
  }
}

const envT3Home = Config.string("T3CODE_HOME").pipe(Config.option);

const resolveThemePaths = Effect.fn(function* (explicitBaseDir: Option.Option<string>) {
  // Same precedence as the rest of the CLI: --base-dir, then T3CODE_HOME,
  // then the default home. A provisioning script exporting T3CODE_HOME must
  // not have this one command silently target the default install.
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

/**
 * Reads the sparse settings object, treating only a genuinely absent file as
 * empty. A permission or I/O error must propagate: reading it as "no settings"
 * would have the caller write a fresh sparse file over settings it never saw.
 */
const readSettingsObject = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(settingsPath)
    .pipe(Effect.mapError((cause) => new ThemeSettingsUnreadableError({ settingsPath, cause })));
  if (!exists) return { raw: "", settings: {} };

  const raw = yield* fs
    .readFileString(settingsPath)
    .pipe(Effect.mapError((cause) => new ThemeSettingsUnreadableError({ settingsPath, cause })));
  if (raw.trim().length === 0) return { raw, settings: {} };

  const settings = yield* decodeSettingsJson(raw).pipe(
    Effect.mapError((cause) => new ThemeSettingsMalformedError({ settingsPath, cause })),
  );
  return { raw, settings };
});

/**
 * A running server owns this file too, and its write path is an in-process
 * semaphore that cannot serialize against another process. So the document is
 * re-read immediately before the rename and the whole edit is retried when it
 * moved underneath us, which is what turns "last writer wins" into "last
 * writer merges", and an edit that keeps losing the race fails loudly rather
 * than overwriting. A write landing inside the remaining rename window is
 * still possible; the server's own watcher reconciles the file either way.
 */
const CONCURRENT_WRITE_ATTEMPTS = 5;

const writeDefaultTheme = Effect.fn(function* (input: {
  readonly settingsPath: string;
  readonly themeId: string;
}) {
  const fs = yield* FileSystem.FileSystem;

  for (let attempt = 1; ; attempt++) {
    const { raw, settings } = yield* readSettingsObject(input.settingsPath);
    const setAt = DateTime.formatIso(yield* DateTime.now);
    const next =
      input.themeId.length > 0
        ? // The timestamp is the set-generation: it lets clients apply a re-set
          // of the same value they already applied once.
          { ...settings, defaultTheme: input.themeId, defaultThemeSetAt: setAt }
        : // Clearing removes the keys rather than storing empty strings, so the
          // file reads the same as one that never set a theme.
          Object.fromEntries(
            Object.entries(settings).filter(
              ([key]) => key !== "defaultTheme" && key !== "defaultThemeSetAt",
            ),
          );

    const contents = yield* encodeSettingsJson(next);
    const current = yield* fs
      .readFileString(input.settingsPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (current !== raw) {
      // Falling through here would overwrite whatever landed in between, which
      // is exactly the loss this loop exists to prevent.
      if (attempt >= CONCURRENT_WRITE_ATTEMPTS) {
        return yield* Effect.fail(
          new ThemeSettingsBusyError({
            settingsPath: input.settingsPath,
            attempts: CONCURRENT_WRITE_ATTEMPTS,
          }),
        );
      }
      continue;
    }

    yield* writeFileStringAtomically({
      filePath: input.settingsPath,
      contents: `${contents}\n`,
    }).pipe(
      Effect.mapError(
        (cause) => new ThemeSettingsWriteError({ settingsPath: input.settingsPath, cause }),
      ),
    );
    return;
  }
});

/** Publishes a theme file into the environment's themes directory and returns
 * the id it published under. */
const publishThemeFile = Effect.fn(function* (input: {
  readonly themesDir: string;
  readonly filePath: string;
  readonly explicitId: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A preflight for error quality only: it tells a FIFO from an oversized
  // file. Enforcement happens at the guarded read below.
  const info = yield* fs
    .stat(input.filePath)
    .pipe(
      Effect.mapError((cause) => new ThemeFileUnreadableError({ filePath: input.filePath, cause })),
    );
  if (info.type !== "File") {
    return yield* Effect.fail(new ThemeFileUnreadableError({ filePath: input.filePath }));
  }
  if (Number(info.size) > MAX_THEME_FILE_BYTES) {
    return yield* Effect.fail(
      new ThemeFileTooLargeError({ filePath: input.filePath, limit: MAX_THEME_FILE_BYTES }),
    );
  }

  // The stat above is diagnostic, naming the failure precisely. The read goes
  // through one opened handle, so its type and size checks bind to the file
  // actually read even if the path was swapped since the stat.
  const raw = readThemeFileGuarded(input.filePath, MAX_THEME_FILE_BYTES);
  if (raw === null) {
    return yield* Effect.fail(new ThemeFileUnreadableError({ filePath: input.filePath }));
  }

  const decoded = decodeThemeFileJsonExit(raw);
  if (decoded._tag === "Failure") {
    return yield* Effect.fail(
      new ThemeFileInvalidError({ filePath: input.filePath, cause: decoded.cause }),
    );
  }
  if (!environmentThemeFileHasColors(decoded.value)) {
    return yield* Effect.fail(new ThemeFileColorlessError({ filePath: input.filePath }));
  }

  const fileBasename = path.basename(input.filePath, ".json");
  const themeId = Option.getOrElse(input.explicitId, () => fileBasename);
  // The same rules the watcher applies when it reads the directory back, so a
  // publish cannot report success for a file that will then be skipped.
  if (!isEnvironmentThemeId(themeId) || UNPUBLISHABLE_THEME_IDS.has(themeId)) {
    return yield* Effect.fail(new ThemeFileIdInvalidError({ themeId, filePath: input.filePath }));
  }

  const destinationPath = path.join(input.themesDir, `${themeId}.json`);
  // Captured for rollback: publish-and-set is one command, so a failure after
  // this write must put the directory back rather than leave a half-applied
  // publish, or a clobbered previous theme, behind.
  const previous = readThemeFileGuarded(destinationPath, MAX_THEME_FILE_BYTES);
  // Written verbatim: appending so much as a newline could push a file at
  // the size limit past it and have the watcher skip what was just accepted.
  yield* writeFileStringAtomically({
    filePath: destinationPath,
    contents: raw,
  }).pipe(Effect.mapError((cause) => new ThemePublishError({ themesDir: input.themesDir, cause })));

  const revert =
    previous === null
      ? fs.remove(destinationPath).pipe(Effect.ignore)
      : writeFileStringAtomically({ filePath: destinationPath, contents: previous }).pipe(
          Effect.ignore,
        );
  return { themeId, revert };
});

/**
 * Ids a client can actually resolve: this build's built-ins plus what the
 * machine publishes, read through the same function the watcher uses so a file
 * it would skip can never be accepted here. The mobile default is absent on
 * purpose -- web and desktop cannot resolve it and mobile does not follow this
 * setting, so naming it would be the silent no-op this check exists to stop.
 */
const resolvableThemeIds = Effect.fn(function* (themesDir: string) {
  const published = yield* readPublishedThemes(themesDir);
  return [...BUILT_IN_THEME_IDS, ...published.map((theme) => theme.id)].toSorted();
});

const themeSetCommand = Command.make("set", {
  baseDir: baseDirFlag,
  id: Flag.string("id").pipe(
    Flag.withDescription("Theme id to publish a file under, instead of its filename."),
    Flag.optional,
  ),
  theme: Argument.string("theme").pipe(
    Argument.withDescription(
      'A theme id (a built-in, or one this machine publishes — themes/nightfall.json is "nightfall"), or a path to a theme JSON file to publish and set in one step.',
    ),
  ),
}).pipe(
  Command.withDescription("Set the environment's theme; connected clients switch to it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* expandHomePath(flags.theme.trim());
      if (target.length === 0) {
        return yield* Effect.fail(new ThemeTargetMissingError());
      }
      const paths = yield* resolveThemePaths(flags.baseDir);

      // An existing file publishes; anything path-shaped that does not exist
      // is a mistake to surface, not an id to store; everything else must be
      // a well-formed id, so a typo cannot be written as a theme no client
      // will ever resolve.
      // Path-shaped first, existence second. Deciding on existence alone would
      // make `t3 theme set ocean` publish ./ocean whenever the cwd happens to
      // hold a file by that name, instead of selecting the built-in.
      const looksLikePath =
        target.endsWith(".json") ||
        target.includes("/") ||
        target.includes("\\") ||
        target.startsWith("~");
      const targetIsFile =
        looksLikePath && (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)));
      let themeId: string;
      let revertPublish: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =
        Effect.void;
      if (targetIsFile) {
        // Settings are preflighted before publishing, so a settings file the
        // set step cannot read or parse fails the command before it mutates
        // the themes directory.
        yield* readSettingsObject(paths.settingsPath);
        const published = yield* publishThemeFile({
          themesDir: paths.themesDir,
          filePath: target,
          explicitId: flags.id,
        });
        themeId = published.themeId;
        revertPublish = published.revert;
      } else if (looksLikePath) {
        return yield* Effect.fail(new ThemeFileUnreadableError({ filePath: target }));
      } else if (isEnvironmentThemeId(target)) {
        const known = yield* resolvableThemeIds(paths.themesDir);
        if (!known.includes(target)) {
          return yield* Effect.fail(new ThemeIdUnknownError({ themeId: target, known }));
        }
        themeId = target;
      } else {
        return yield* Effect.fail(new ThemeIdInvalidError({ themeId: target }));
      }

      // set means set: if the default cannot be written, the publish that
      // rode along with it is undone rather than left as a side effect of a
      // command that reported failure.
      yield* writeDefaultTheme({ settingsPath: paths.settingsPath, themeId }).pipe(
        Effect.onError(() => revertPublish),
      );
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
