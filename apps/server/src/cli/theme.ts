// @effect-diagnostics nodeBuiltinImport:off - publish commits and rollbacks
// move exact directory entries with rename, which the FileSystem service does
// not expose atomically.
import * as NodeFS from "node:fs";

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
import { Argument, Command, Flag } from "effect/cli";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import {
  MAX_THEME_FILE_BYTES,
  readPublishedThemes,
  readThemeFileGuarded,
} from "../environmentTheme.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));
const decodeThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

export class ThemeSettingsUnreadableError extends Schema.TaggedError<ThemeSettingsUnreadableError>()(
  "ThemeSettingsUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix its permissions, then run this again.`;
  }
}

export class ThemeSettingsMalformedError extends Schema.TaggedError<ThemeSettingsMalformedError>()(
  "ThemeSettingsMalformedError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.settingsPath} is not a JSON object. Fix or remove it, then run this again.`;
  }
}

export class ThemeSettingsBusyError extends Schema.TaggedError<ThemeSettingsBusyError>()(
  "ThemeSettingsBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing (gave up after ${this.attempts} attempts). Try again.`;
  }
}

export class ThemeSettingsWriteError extends Schema.TaggedError<ThemeSettingsWriteError>()(
  "ThemeSettingsWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

export class ThemeFileUnreadableError extends Schema.TaggedError<ThemeFileUnreadableError>()(
  "ThemeFileUnreadableError",
  { filePath: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read ${this.filePath}.`;
  }
}

export class ThemeFileInvalidError extends Schema.TaggedError<ThemeFileInvalidError>()(
  "ThemeFileInvalidError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.filePath} is not a valid theme file. Use a theme exported from T3 Code, or a seeded file with name, appearance, canvas, and accent.`;
  }
}

export class ThemeFileTooLargeError extends Schema.TaggedError<ThemeFileTooLargeError>()(
  "ThemeFileTooLargeError",
  { filePath: Schema.String, limit: Schema.Number },
) {
  override get message(): string {
    return `${this.filePath} is larger than ${this.limit} bytes, which is more than a theme can publish.`;
  }
}

export class ThemeFileColorlessError extends Schema.TaggedError<ThemeFileColorlessError>()(
  "ThemeFileColorlessError",
  { filePath: Schema.String },
) {
  override get message(): string {
    return `${this.filePath} has no colors to publish.`;
  }
}

export class ThemePublishError extends Schema.TaggedError<ThemePublishError>()(
  "ThemePublishError",
  { themesDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not publish the theme into ${this.themesDir}.`;
  }
}

const INVALID_THEME_ID_REASON =
  "is not a valid theme id (lowercase letters, digits, and hyphens; not an appearance keyword)";

export class ThemeIdUnknownError extends Schema.TaggedError<ThemeIdUnknownError>()(
  "ThemeIdUnknownError",
  { themeId: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `No theme named "${this.themeId}". Available: ${this.known.join(", ")}. Publish one by passing a theme file instead of an id.`;
  }
}

export class ThemeIdInvalidError extends Schema.TaggedError<ThemeIdInvalidError>()(
  "ThemeIdInvalidError",
  { themeId: Schema.String },
) {
  override get message(): string {
    return `"${this.themeId}" ${INVALID_THEME_ID_REASON}.`;
  }
}

export class ThemeFileIdInvalidError extends Schema.TaggedError<ThemeFileIdInvalidError>()(
  "ThemeFileIdInvalidError",
  { themeId: Schema.String, filePath: Schema.String },
) {
  override get message(): string {
    return `"${this.themeId}" ${INVALID_THEME_ID_REASON}. Pass one with --id.`;
  }
}

export class ThemeTargetMissingError extends Schema.TaggedError<ThemeTargetMissingError>()(
  "ThemeTargetMissingError",
  {},
) {
  override get message(): string {
    return "Provide a theme id or file, or run `t3 theme clear` to remove the theme.";
  }
}

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

/** Propagate read errors to avoid overwriting unread settings with a sparse file. */
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

/** The server's in-process semaphore cannot serialize writes from this process. */
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
        ? // The timestamp lets clients reapply the same theme.
          { ...settings, defaultTheme: input.themeId, defaultThemeSetAt: setAt }
        : Object.fromEntries(
            Object.entries(settings).filter(
              ([key]) => key !== "defaultTheme" && key !== "defaultThemeSetAt",
            ),
          );

    const contents = yield* encodeSettingsJson(next);
    const current = yield* fs
      .readFileString(input.settingsPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (current !== raw) {
      if (attempt >= CONCURRENT_WRITE_ATTEMPTS) {
        return yield* new ThemeSettingsBusyError({
          settingsPath: input.settingsPath,
          attempts: CONCURRENT_WRITE_ATTEMPTS,
        });
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

const publishThemeFile = Effect.fn(function* (input: {
  readonly themesDir: string;
  readonly filePath: string;
  readonly explicitId: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs
    .stat(input.filePath)
    .pipe(
      Effect.mapError((cause) => new ThemeFileUnreadableError({ filePath: input.filePath, cause })),
    );
  if (info.type !== "File") {
    return yield* new ThemeFileUnreadableError({ filePath: input.filePath });
  }
  if (Number(info.size) > MAX_THEME_FILE_BYTES) {
    return yield* new ThemeFileTooLargeError({
      filePath: input.filePath,
      limit: MAX_THEME_FILE_BYTES,
    });
  }

  const resolvedSource = yield* fs
    .realPath(input.filePath)
    .pipe(
      Effect.mapError((cause) => new ThemeFileUnreadableError({ filePath: input.filePath, cause })),
    );
  const raw = readThemeFileGuarded(resolvedSource, MAX_THEME_FILE_BYTES);
  if (raw === null) {
    return yield* new ThemeFileUnreadableError({ filePath: input.filePath });
  }

  const decoded = decodeThemeFileJsonExit(raw);
  if (decoded._tag === "Failure") {
    return yield* new ThemeFileInvalidError({ filePath: input.filePath, cause: decoded.cause });
  }
  if (!environmentThemeFileHasColors(decoded.value)) {
    return yield* new ThemeFileColorlessError({ filePath: input.filePath });
  }

  const fileBasename = path.basename(input.filePath, ".json");
  const themeId = Option.getOrElse(input.explicitId, () => fileBasename);
  // Match watcher validation so published files will not be skipped.
  if (!isEnvironmentThemeId(themeId) || UNPUBLISHABLE_THEME_IDS.has(themeId)) {
    return yield* new ThemeFileIdInvalidError({ themeId, filePath: input.filePath });
  }

  const destinationPath = path.join(input.themesDir, `${themeId}.json`);
  // Non-JSON suffixes hide these from the watcher; PIDs isolate concurrent publishers.
  const backupPath = `${destinationPath}.rollback-${process.pid}`;
  const stagingPath = `${destinationPath}.staging-${process.pid}`;
  yield* fs
    .makeDirectory(input.themesDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new ThemePublishError({ themesDir: input.themesDir, cause })));

  const publishFailure = (cause: unknown) =>
    new ThemePublishError({ themesDir: input.themesDir, cause });

  // O_EXCL prevents following a symlink at the predictable staging path.
  // Preserve bytes exactly: even an added newline could exceed the watcher's size limit.
  const stagedIno = yield* Effect.try({
    try: () => {
      try {
        NodeFS.unlinkSync(stagingPath);
      } catch {}
      const fd = NodeFS.openSync(
        stagingPath,
        NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
        0o644,
      );
      try {
        NodeFS.writeFileSync(fd, raw);
        return NodeFS.fstatSync(fd).ino;
      } finally {
        NodeFS.closeSync(fd);
      }
    },
    catch: publishFailure,
  });

  // Atomic rename avoids a check/replace race and preserves the exact entry for rollback.
  const hadPrevious = yield* Effect.try({
    try: () => {
      try {
        NodeFS.renameSync(destinationPath, backupPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    catch: publishFailure,
  });

  const revert = Effect.sync(() => {
    try {
      NodeFS.unlinkSync(stagingPath);
    } catch {}
    try {
      // Only replace this process's inode or an empty destination; concurrent publishers win.
      const destinationIno = (() => {
        try {
          return NodeFS.lstatSync(destinationPath).ino;
        } catch {
          return null;
        }
      })();
      if (hadPrevious) {
        if (destinationIno === null || destinationIno === stagedIno) {
          NodeFS.renameSync(backupPath, destinationPath);
        } else {
          NodeFS.unlinkSync(backupPath);
        }
      } else if (destinationIno === stagedIno) {
        NodeFS.unlinkSync(destinationPath);
      }
    } catch {}
  });
  const cleanup = Effect.sync(() => {
    try {
      if (hadPrevious) NodeFS.unlinkSync(backupPath);
    } catch {}
  });

  yield* Effect.try({
    try: () => NodeFS.renameSync(stagingPath, destinationPath),
    catch: publishFailure,
  }).pipe(Effect.onError(() => revert));

  return { themeId, revert, cleanup };
});

/** Web and desktop cannot resolve the mobile default, and mobile does not follow this setting. */
const resolvableThemeIds = Effect.fn(function* (themesDir: string) {
  const published = yield* readPublishedThemes(themesDir);
  return [...BUILT_IN_THEME_IDS, ...published.map((theme) => theme.id)].toSorted();
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
