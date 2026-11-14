// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type DefaultAppearancePreference,
  EnvironmentTheme,
  type ServerSettingsError,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import { BUILT_IN_THEME_IDS, UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import { fileHeaderMimeType } from "./workspace/fileHeaderMimeType.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const encodeEnvironmentThemeFileJson = Schema.encodeEffect(
  fromJsonStringPretty(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/** Shared with publishing so it cannot accept files the watcher skips. */
export const MAX_THEME_FILE_BYTES = 32 * 1024;
const MAX_THEME_TOTAL_BYTES = 192 * 1024;

/** A theme's background is `<id>.<extension>` beside `<id>.json`; earlier extensions win. */
const THEME_BACKGROUND_EXTENSIONS = ["webp", "png", "jpg", "jpeg"] as const;
const THEME_BACKGROUND_EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};
const MAX_THEME_BACKGROUND_BYTES = 16 * 1024 * 1024;

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

const INVALID_ID =
  "is not a valid theme id. Use lowercase letters, digits, and hyphens, and not a built-in name.";
const NOT_PUBLISHED = "could not be published. The themes directory may be full or not writable.";

/** A theme the service will not publish or select. `problem` ends the sentence naming it. */
export class EnvironmentThemeRefusedError extends Schema.TaggedError<EnvironmentThemeRefusedError>()(
  "EnvironmentThemeRefusedError",
  {
    themeId: Schema.String,
    problem: Schema.String,
    known: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const known = this.known ? ` Available: ${this.known.join(", ")}.` : "";
    return `Theme "${this.themeId}" ${this.problem}${known}`;
  }
}

/** The settings write that makes a theme or mode the default failed. */
export class EnvironmentThemeNotSelectedError extends Schema.TaggedError<EnvironmentThemeNotSelectedError>()(
  "EnvironmentThemeNotSelectedError",
  {
    /** Absent when only the appearance was set. */
    themeId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const subject = this.themeId === undefined ? "The appearance" : `Theme "${this.themeId}"`;
    return `${subject} was not applied, because the settings could not be saved.`;
  }
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /** The default theme id and the published themes, plus the one named `themeId`. */
    readonly read: (themeId?: string) => Effect.Effect<
      {
        readonly current: string;
        readonly themes: ReadonlyArray<EnvironmentTheme>;
        readonly theme?: EnvironmentTheme;
      },
      EnvironmentThemeRefusedError | ServerSettingsError
    >;

    /**
     * Makes `themeId` the environment theme and `appearance` its mode, so connected clients
     * switch to them. With `theme`, first publishes that file under the id, replacing one already
     * there. `background` copies the image at that path beside the theme; null removes it.
     */
    readonly apply: (
      input:
        | {
            readonly themeId: string;
            readonly theme?: EnvironmentThemeFile | undefined;
            readonly appearance?: Exclude<DefaultAppearancePreference, ""> | undefined;
            readonly background?: string | null | undefined;
          }
        | { readonly appearance: Exclude<DefaultAppearancePreference, ""> },
    ) => Effect.Effect<void, EnvironmentThemeRefusedError | EnvironmentThemeNotSelectedError>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

/** True when anything, a dangling symlink included, is at the path. */
const pathIsTaken = (filePath: string): boolean => {
  try {
    NodeFS.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Validates and reads one handle; rejects symlinked files, allows symlinked directories.
 * Uses non-blocking opens against FIFOs; Windows lacks these flags and checks symlinks with lstat. */
export const readThemeFileGuarded = (filePath: string, maxBytes: number): string | null => {
  let fd: number;
  try {
    if (NodeFS.constants.O_NOFOLLOW === undefined && NodeFS.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    fd = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    // Unlike Buffer#toString, TextDecoder drops a UTF-8 BOM, which JSON.parse rejects.
    return new TextDecoder().decode(contents.subarray(0, offset));
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * The background image published beside `themeId`, if any. Symlinks and oversized files are
 * skipped. `entries` lets a directory scan skip lookups for names it did not list.
 */
export function findThemeBackground(
  themesDir: string,
  themeId: string,
  entries?: ReadonlySet<string>,
): { readonly path: string; readonly revision: string } | null {
  for (const extension of THEME_BACKGROUND_EXTENSIONS) {
    const name = `${themeId}.${extension}`;
    if (entries !== undefined && !entries.has(name)) continue;
    // Native separators: the asset route refuses a path that differs from its canonical form.
    const filePath = NodePath.join(themesDir, name);
    let info: NodeFS.BigIntStats;
    try {
      info = NodeFS.lstatSync(filePath, { bigint: true });
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_THEME_BACKGROUND_BYTES) continue;
    return {
      path: filePath,
      revision: [info.ino, info.size, info.mtimeNs].map((part) => part.toString(36)).join("-"),
    };
  }
  return null;
}

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const themes: Array<EnvironmentTheme> = [];
  const entryNames = new Set(entries);
  let examined = 0;
  let totalBytes = 0;
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    // Reserved ids shadow built-ins or capture clients that never chose them.
    if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    // Cap examined files, not accepted themes, to bound work on malformed directories.
    examined += 1;
    if (examined > MAX_THEME_FILES) {
      yield* Effect.logWarning("ignoring environment theme files past the limit", {
        path: themesDir,
        limit: MAX_THEME_FILES,
      });
      break;
    }

    const filePath = `${themesDir}/${entry}`;
    const raw = readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES);
    if (raw === null) {
      yield* Effect.logWarning("ignoring unusable environment theme file", {
        path: filePath,
        limit: MAX_THEME_FILE_BYTES,
      });
      continue;
    }
    if (raw.trim().length === 0) continue;

    const decoded = decodeEnvironmentThemeFileJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("ignoring invalid environment theme", {
        path: filePath,
        detail: Cause.pretty(decoded.cause),
      });
      continue;
    }
    const file = decoded.value;
    if (!environmentThemeFileHasColors(file)) {
      yield* Effect.logWarning("ignoring environment theme without colors", { path: filePath });
      continue;
    }

    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_THEME_TOTAL_BYTES) {
      yield* Effect.logWarning("ignoring environment themes past the total size limit", {
        path: themesDir,
        limit: MAX_THEME_TOTAL_BYTES,
      });
      break;
    }

    const background = findThemeBackground(themesDir, id, entryNames);
    themes.push({ id, ...file, ...(background ? { background: background.revision } : {}) });
  }
  return themes;
});

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Sequence numbers let subscribers drop queued events older than their initial snapshot.
  const changes = yield* PubSub.sliding<PublishedThemes>(1);
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  // Serialize read/compare/publish so slow older reads cannot publish with newer sequence numbers.
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const themes = yield* readPublishedThemes(environmentThemesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      // Compare the whole value so new fields cannot silently miss republishes.
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedThemes], PublishedThemes] => {
          if (Equal.equals(previous.themes, themes)) return [[false, previous], previous];
          const updated: PublishedThemes = { seq: previous.seq + 1, themes };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  yield* fs
    .makeDirectory(environmentThemesDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  // A save emits several events, and fs.watch can fire before content is flushed.
  const watchEvents = fs.watch(environmentThemesDir).pipe(Stream.debounce(Duration.millis(100)));

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  // One publish at a time: they share a staging path, and each one checks what is served after it.
  const publishSemaphore = yield* Semaphore.make(1);

  /** Callers hold `publishSemaphore`. Succeeds with the effect that undoes this publish. */

  const publish = Effect.fnUntraced(function* (themeId: string, file: EnvironmentThemeFile) {
    if (UNPUBLISHABLE_THEME_IDS.has(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    if (!environmentThemeFileHasColors(file)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "has no colors. Give canvas and accent, or at least one color role.",
      });
    }
    if (file.css !== undefined && themeCssLoadsRemoteFiles(file.css)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem:
          "has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.",
      });
    }
    const contents = yield* encodeEnvironmentThemeFileJson(file).pipe(
      Effect.mapError(
        (cause) => new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
      ),
    );
    if (Buffer.byteLength(contents) > MAX_THEME_FILE_BYTES) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: `is larger than ${MAX_THEME_FILE_BYTES} bytes.`,
      });
    }

    const destination = `${environmentThemesDir}/${themeId}${THEME_FILE_SUFFIX}`;
    // The watcher reads only .json names, so it never sees a half-written file.
    const staging = `${destination}.staging-${process.pid}`;
    // Exclusive create: a link left at the staging path is removed, never written through.
    const replace = (next: string) =>
      fs.remove(staging, { force: true }).pipe(
        Effect.andThen(fs.writeFileString(staging, next, { flag: "wx" })),
        Effect.andThen(fs.rename(staging, destination)),
        Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      );

    // The guarded reader does not block on a FIFO and does not follow a symlink.
    const previous = Option.fromNullOr(readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES));
    // A file it cannot read back, such as one over the size limit, could not be restored.
    if (Option.isNone(previous) && pathIsTaken(destination)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "would replace a file that could not be backed up. Use another theme id.",
      });
    }
    const servedBefore = (yield* refresh).themes.map((theme) => theme.id);
    // Puts back what was there, so a failed apply does not take a working theme away.
    const revert = Option.match(previous, {
      onNone: () => fs.remove(destination, { force: true }),
      onSome: replace,
    }).pipe(Effect.ignore, Effect.andThen(refresh), Effect.asVoid);

    yield* fs.makeDirectory(environmentThemesDir, { recursive: true }).pipe(
      Effect.andThen(replace(contents)),
      Effect.mapError(
        (cause) => new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
      ),
    );
    // The reader stops at its count and size limits, so this file can go unserved, or it can
    // push another theme out. Both count as a failed publish.
    const served = new Set((yield* refresh).themes.map((theme) => theme.id));
    if (served.has(themeId) && servedBefore.every((id) => served.has(id))) return revert;
    yield* revert;
    return yield* new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED });
  });

  /** Reads and checks a background before anything is written, so a bad path changes nothing. */
  const readBackground = Effect.fnUntraced(function* (themeId: string, sourcePath: string) {
    const refuse = (problem: string) => new EnvironmentThemeRefusedError({ themeId, problem });
    const unreadable = () => refuse(`has a background image that could not be read: ${sourcePath}`);
    if (!NodePath.isAbsolute(sourcePath) || isNetworkPath(sourcePath)) {
      return yield* refuse("needs an absolute path to a background image on this machine.");
    }
    const info = yield* fs.stat(sourcePath).pipe(Effect.mapError(unreadable));
    if (info.type !== "File") return yield* unreadable();
    const tooLarge = refuse(
      `has a background image larger than ${MAX_THEME_BACKGROUND_BYTES / 1024 / 1024} MB.`,
    );
    if (info.size > MAX_THEME_BACKGROUND_BYTES) return yield* tooLarge;
    const bytes = yield* fs.readFile(sourcePath).pipe(Effect.mapError(unreadable));
    if (bytes.byteLength > MAX_THEME_BACKGROUND_BYTES) return yield* tooLarge;
    // The bytes decide the type, so only a real image can be served from the themes directory.
    const extension = THEME_BACKGROUND_EXTENSION_BY_TYPE[fileHeaderMimeType(bytes) ?? ""];
    if (extension === undefined) {
      return yield* refuse("has a background image that is not a JPEG, PNG, or WebP file.");
    }
    return { bytes, extension };
  });

  /** Replaces the theme's background, or removes it for null. Callers hold `publishSemaphore`. */
  const writeBackground = Effect.fnUntraced(function* (
    themeId: string,
    image: { readonly bytes: Uint8Array; readonly extension: string } | null,
  ) {
    const destination = image && `${environmentThemesDir}/${themeId}.${image.extension}`;
    const write = Effect.gen(function* () {
      if (image && destination) {
        const staging = `${destination}.staging-${process.pid}`;
        yield* fs.remove(staging, { force: true }).pipe(
          Effect.andThen(fs.writeFile(staging, image.bytes, { flag: "wx" })),
          Effect.andThen(fs.rename(staging, destination)),
          Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
        );
      }
      // Another extension left behind could take precedence over the new image.
      for (const extension of THEME_BACKGROUND_EXTENSIONS) {
        const filePath = `${environmentThemesDir}/${themeId}.${extension}`;
        if (filePath !== destination) yield* fs.remove(filePath, { force: true });
      }
    });
    yield* write.pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentThemeRefusedError({
            themeId,
            problem: "background image could not be saved in the themes directory.",
            cause,
          }),
      ),
    );
    yield* refresh;
  });

  const apply: EnvironmentThemeService["Service"]["apply"] = Effect.fn(
    "EnvironmentThemeService.apply",
  )(function* (input) {
    const themeId = "themeId" in input ? input.themeId : undefined;
    const theme = "theme" in input ? input.theme : undefined;
    const background = "background" in input ? input.background : undefined;
    const { appearance } = input;
    if (themeId !== undefined && !isEnvironmentThemeId(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    if (themeId !== undefined && background !== undefined && UNPUBLISHABLE_THEME_IDS.has(themeId)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "is built in, so it cannot have a background image. Publish a theme first.",
      });
    }
    // Timestamps make clients apply a set again when its value did not change. Theme and
    // appearance have one each, so setting one does not undo a later local choice of the other.
    const select = Effect.gen(function* () {
      const setAt = DateTime.formatIso(yield* DateTime.now);
      yield* settings
        .updateSettings({
          ...(themeId === undefined ? {} : { defaultTheme: themeId, defaultThemeSetAt: setAt }),
          ...(appearance === undefined
            ? {}
            : { defaultAppearance: appearance, defaultAppearanceSetAt: setAt }),
        })
        .pipe(Effect.mapError((cause) => new EnvironmentThemeNotSelectedError({ themeId, cause })));
    });
    // One at a time, so a selection never sees a file that a failed publish then takes back.
    // If the theme cannot be selected, the file it replaced comes back.
    yield* publishSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (themeId === undefined) return yield* select;
        const image =
          typeof background === "string" ? yield* readBackground(themeId, background) : null;
        const setBackground =
          background === undefined ? Effect.void : writeBackground(themeId, image);
        if (theme === undefined) {
          const known = [...BUILT_IN_THEME_IDS, ...(yield* refresh).themes.map(({ id }) => id)];
          if (!known.includes(themeId)) {
            return yield* new EnvironmentThemeRefusedError({
              themeId,
              problem: "is not a built-in or published theme.",
              known,
            });
          }
          yield* select;
          return yield* setBackground;
        }
        const revert = yield* publish(themeId, theme);
        yield* select.pipe(Effect.tapError(() => revert));
        // After selection, so a refused selection leaves the background as it was.
        yield* setBackground;
      }),
    );
  });

  const read: EnvironmentThemeService["Service"]["read"] = Effect.fn(
    "EnvironmentThemeService.read",
  )(function* (themeId) {
    const { themes } = yield* refresh;
    const { defaultTheme } = yield* settings.getSettings;
    if (themeId === undefined) return { current: defaultTheme, themes };
    const theme = themes.find((candidate) => candidate.id === themeId);
    if (theme === undefined) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "is not a published theme.",
        known: themes.map(({ id }) => id),
      });
    }
    return { current: defaultTheme, themes, theme };
  });

  return {
    current: Effect.map(refresh, (state) => state.themes),
    read,
    apply,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.themes),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.themes),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentThemeService["Service"];
});

export const layer = Layer.effect(EnvironmentThemeService, make);
