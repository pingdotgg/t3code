// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { BUILT_IN_THEMES, UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import { parseThemeColor } from "@t3tools/shared/themeColor";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const decodeThemeFile = Schema.decodeEffect(EnvironmentThemeFile);
const encodeThemeFile = Schema.encodeEffect(Schema.fromJsonString(EnvironmentThemeFile));
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/** Shared with publishing so it cannot accept files the watcher skips. */
export const MAX_THEME_FILE_BYTES = 32 * 1024;
const MAX_THEME_TOTAL_BYTES = 192 * 1024;

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

export class ThemeLibraryError extends Schema.TaggedError<ThemeLibraryError>()(
  "ThemeLibraryError",
  {
    reason: Schema.Literals([
      "invalid",
      "not_found",
      "builtin",
      "collision",
      "default_in_use",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "default_in_use"
      ? "Clear or change the environment default before deleting its theme."
      : `Theme library operation refused: ${this.reason}.`;
  }
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly list: Effect.Effect<ReadonlyArray<EnvironmentTheme>, ThemeLibraryError>;
    readonly read: (id: string) => Effect.Effect<EnvironmentTheme, ThemeLibraryError>;
    readonly save: (input: {
      readonly id: string;
      readonly theme: EnvironmentThemeFile;
      readonly overwrite: boolean;
    }) => Effect.Effect<EnvironmentTheme, ThemeLibraryError>;
    readonly duplicate: (input: {
      readonly sourceId: string;
      readonly id: string;
      readonly name: string;
    }) => Effect.Effect<EnvironmentTheme, ThemeLibraryError>;
    readonly remove: (id: string) => Effect.Effect<void, ThemeLibraryError>;
    readonly setDefault: (id: string) => Effect.Effect<void, ThemeLibraryError>;
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

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

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const themes: Array<EnvironmentTheme> = [];
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

    themes.push({ id, ...file });
  }
  return themes;
});

const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));

class ThemeSettingsUnreadableError extends Schema.TaggedError<ThemeSettingsUnreadableError>()(
  "ThemeSettingsUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix its permissions, then run this again.`;
  }
}

class ThemeSettingsMalformedError extends Schema.TaggedError<ThemeSettingsMalformedError>()(
  "ThemeSettingsMalformedError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.settingsPath} is not a JSON object. Fix or remove it, then run this again.`;
  }
}

class ThemeSettingsBusyError extends Schema.TaggedError<ThemeSettingsBusyError>()(
  "ThemeSettingsBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing (gave up after ${this.attempts} attempts). Try again.`;
  }
}

class ThemeSettingsWriteError extends Schema.TaggedError<ThemeSettingsWriteError>()(
  "ThemeSettingsWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

class ThemePublishError extends Schema.TaggedError<ThemePublishError>()("ThemePublishError", {
  themesDir: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not publish the theme into ${this.themesDir}.`;
  }
}

/** Propagate read errors to avoid overwriting unread settings with a sparse file. */
export const readSettingsObject = Effect.fn("EnvironmentTheme.readSettings")(function* (
  settingsPath: string,
) {
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

/** CLI writes can come from other processes, outside the service semaphore. */
const CONCURRENT_WRITE_ATTEMPTS = 5;

export const writeDefaultTheme = Effect.fn("EnvironmentTheme.writeDefault")(function* (input: {
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

/** Stages and renames into the watched directory; callers run `cleanup` on success or `revert` to undo. */
export const publishThemeContents = Effect.fn("EnvironmentTheme.publish")(function* (input: {
  readonly themesDir: string;
  readonly themeId: string;
  readonly raw: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { themeId, raw } = input;
  const publishFailure = (cause: unknown) =>
    new ThemePublishError({ themesDir: input.themesDir, cause });
  yield* fs
    .makeDirectory(input.themesDir, { recursive: true })
    .pipe(Effect.mapError(publishFailure));
  // The watcher reads entries in name order up to its limits, so a new id must not push others out.
  const others = (yield* fs.readDirectory(input.themesDir).pipe(Effect.mapError(publishFailure)))
    .filter((entry) => entry !== `${themeId}${THEME_FILE_SUFFIX}`)
    .filter((entry) => {
      const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
      return (
        entry.endsWith(THEME_FILE_SUFFIX) &&
        isEnvironmentThemeId(id) &&
        !UNPUBLISHABLE_THEME_IDS.has(id)
      );
    });
  const totalBytes = others.reduce(
    (total, entry) =>
      total +
      Buffer.byteLength(
        readThemeFileGuarded(path.join(input.themesDir, entry), MAX_THEME_FILE_BYTES) ?? "",
      ),
    Buffer.byteLength(raw),
  );
  if (others.length >= MAX_THEME_FILES || totalBytes > MAX_THEME_TOTAL_BYTES)
    return yield* publishFailure("Publication limit exceeded");

  const destinationPath = path.join(input.themesDir, `${themeId}${THEME_FILE_SUFFIX}`);
  // Non-JSON suffixes hide staging and rollback entries from the watcher.
  const token = NodeCrypto.randomUUID();
  const backupPath = `${destinationPath}.rollback-${token}`;
  const stagingPath = `${destinationPath}.staging-${token}`;

  // O_EXCL prevents following a symlink at the predictable staging path.
  // Preserve bytes exactly: even an added newline could exceed the watcher's size limit.
  const stagedIno = yield* Effect.try({
    try: () => {
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

  // A concurrent writer outside this process can still fill the directory after the check above.
  const visible = yield* readPublishedThemes(input.themesDir);
  if (!visible.some((theme) => theme.id === themeId)) {
    yield* revert;
    return yield* publishFailure("Publication limit exceeded");
  }
  return { themeId, revert, cleanup };
});

const make = Effect.gen(function* () {
  const { environmentThemesDir, settingsPath } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
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

  const mutationSemaphore = yield* Semaphore.make(1);
  // One mutation at a time, never abandoned between staging and rename.
  const locked = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    mutationSemaphore
      .withPermits(1)(Effect.uninterruptible(effect))
      .pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
  const storageError = (cause: unknown) => new ThemeLibraryError({ reason: "storage", cause });
  const builtins: ReadonlyArray<EnvironmentTheme> = BUILT_IN_THEMES.map((theme) => ({
    id: theme.id,
    version: 1,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
  }));
  const list = Effect.map(refresh, (state) => [...builtins, ...state.themes]);
  const read = Effect.fn("EnvironmentTheme.read")(function* (id: string) {
    const theme = (yield* list).find((theme) => theme.id === id);
    if (!theme) return yield* new ThemeLibraryError({ reason: "not_found" });
    return theme;
  });
  const save = Effect.fn("EnvironmentTheme.save")(function* (input: {
    readonly id: string;
    readonly theme: EnvironmentThemeFile;
    readonly overwrite: boolean;
  }) {
    if (!isEnvironmentThemeId(input.id)) return yield* new ThemeLibraryError({ reason: "invalid" });
    if (UNPUBLISHABLE_THEME_IDS.has(input.id))
      return yield* new ThemeLibraryError({ reason: "builtin" });
    const theme = yield* decodeThemeFile(input.theme).pipe(
      Effect.mapError(() => new ThemeLibraryError({ reason: "invalid" })),
    );
    // Clients render these values as CSS, so reject anything the web palette parser cannot read.
    const colors = [theme.colors, theme.variants?.light, theme.variants?.dark].flatMap((palette) =>
      Object.values(palette ?? {}),
    );
    const raw = yield* encodeThemeFile(theme).pipe(
      Effect.mapError(() => new ThemeLibraryError({ reason: "invalid" })),
    );
    if (
      !environmentThemeFileHasColors(theme) ||
      colors.some((color) => parseThemeColor(color) === null) ||
      Buffer.byteLength(raw) > MAX_THEME_FILE_BYTES
    )
      return yield* new ThemeLibraryError({ reason: "invalid" });
    const destination = path.join(environmentThemesDir, `${input.id}${THEME_FILE_SUFFIX}`);
    const exists = yield* Effect.try({
      try: () => {
        try {
          NodeFS.lstatSync(destination);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      catch: storageError,
    });
    if (exists !== input.overwrite)
      return yield* new ThemeLibraryError({ reason: exists ? "collision" : "not_found" });
    // Existing entries must be readable regular theme files, never symlinks.
    if (exists && readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES) === null)
      return yield* new ThemeLibraryError({ reason: "invalid" });
    const published = yield* publishThemeContents({
      themesDir: environmentThemesDir,
      themeId: input.id,
      raw,
    }).pipe(Effect.mapError(storageError));
    yield* published.cleanup;
    yield* refresh;
    return { id: input.id, ...theme };
  });
  const duplicate = Effect.fn("EnvironmentTheme.duplicate")(function* (input: {
    readonly sourceId: string;
    readonly id: string;
    readonly name: string;
  }) {
    const { id: _id, ...theme } = yield* read(input.sourceId);
    return yield* save({ id: input.id, theme: { ...theme, name: input.name }, overwrite: false });
  });
  const remove = Effect.fn("EnvironmentTheme.remove")(function* (id: string) {
    if (UNPUBLISHABLE_THEME_IDS.has(id)) return yield* new ThemeLibraryError({ reason: "builtin" });
    yield* read(id);
    const { settings } = yield* readSettingsObject(settingsPath).pipe(
      Effect.mapError(storageError),
    );
    if (settings.defaultTheme === id)
      return yield* new ThemeLibraryError({ reason: "default_in_use" });
    yield* fs
      .remove(path.join(environmentThemesDir, `${id}${THEME_FILE_SUFFIX}`))
      .pipe(Effect.mapError(storageError));
    yield* refresh;
  });
  const setDefault = Effect.fn("EnvironmentTheme.setDefault")(function* (id: string) {
    if (id !== "") yield* read(id);
    yield* writeDefaultTheme({ settingsPath, themeId: id }).pipe(Effect.mapError(storageError));
  });

  return {
    list,
    read,
    save: (input) => locked(save(input)),
    duplicate: (input) => locked(duplicate(input)),
    remove: (id) => locked(remove(id)),
    setDefault: (id) => locked(setDefault(id)),
    current: Effect.map(refresh, (state) => state.themes),
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
