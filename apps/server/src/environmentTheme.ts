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
import * as Path from "effect/Path";
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

import * as Settings from "./serverSettings.ts";
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
      "limit",
      "managed",
      "unsupported",
    ]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail;
    return this.reason === "default_in_use"
      ? "Clear or change the environment default before deleting its theme."
      : `Theme library operation refused: ${this.reason}.`;
  }
}

const isThemeLibraryError = Schema.is(ThemeLibraryError);

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly appearance: "light" | "dark";
        readonly builtin: boolean;
      }>,
      ThemeLibraryError
    >;
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
export const readThemeFileGuarded = Effect.fn("EnvironmentTheme.readFile")(
  (filePath: string, maxBytes: number) =>
    Effect.try({
      try: (): string | null => {
        let fd: number;
        try {
          if (
            NodeFS.constants.O_NOFOLLOW === undefined &&
            NodeFS.lstatSync(filePath).isSymbolicLink()
          ) {
            return null;
          }
          fd = NodeFS.openSync(
            filePath,
            NodeFS.constants.O_RDONLY |
              (NodeFS.constants.O_NOFOLLOW ?? 0) |
              (NodeFS.constants.O_NONBLOCK ?? 0),
          );
        } catch (cause) {
          if (
            ["ENOENT", "ENOTDIR", "ELOOP", "ENXIO"].includes(
              (cause as NodeJS.ErrnoException).code ?? "",
            )
          )
            return null;
          throw cause;
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
        } finally {
          NodeFS.closeSync(fd);
        }
      },
      catch: (cause) =>
        new ThemeLibraryError({
          reason: "storage",
          detail:
            "Could not read a published theme file. Check file permissions and disk availability.",
          cause,
        }),
    }),
);

/** CLI and MCP writes require usable colors; the watcher preserves lenient legacy files. */
export const validateThemeFile = Effect.fn("EnvironmentTheme.validateFile")(function* (
  raw: string,
) {
  if (Buffer.byteLength(raw) > MAX_THEME_FILE_BYTES)
    return yield* new ThemeLibraryError({
      reason: "invalid",
      detail: "Theme definition exceeds 32 KiB.",
    });
  const decoded = decodeEnvironmentThemeFileJsonExit(raw);
  if (decoded._tag === "Failure")
    return yield* new ThemeLibraryError({
      reason: "invalid",
      detail: "Theme is not a valid theme file: check name, appearance, colors and variants.",
    });
  const theme = decoded.value;
  if (!environmentThemeFileHasColors(theme))
    return yield* new ThemeLibraryError({
      reason: "invalid",
      detail: "Theme must contain at least one color.",
    });
  for (const [variant, palette] of Object.entries({
    colors: theme.colors,
    light: theme.variants?.light,
    dark: theme.variants?.dark,
  })) {
    for (const [key, color] of Object.entries(palette ?? {})) {
      if (parseThemeColor(color) === null)
        return yield* new ThemeLibraryError({
          reason: "invalid",
          detail: `Invalid theme color at ${variant}.${key}. Use a supported CSS color literal.`,
        });
    }
  }
  return theme;
});

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(themesDir).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed([])
        : Effect.fail(
            new ThemeLibraryError({
              reason: "storage",
              detail:
                "Could not read theme storage. Check directory permissions and disk availability.",
              cause,
            }),
          ),
    ),
  );

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
    const raw = yield* readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES);
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
      yield* Effect.logWarning("ignoring invalid environment theme", { path: filePath });
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

const hardLinksUnavailable = (cause: unknown) =>
  ["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes((cause as NodeJS.ErrnoException).code ?? "");

class ThemePublishError extends Schema.TaggedError<ThemePublishError>()("ThemePublishError", {
  themesDir: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not publish the theme into ${this.themesDir}.`;
  }
}

/** Stages and renames into the watched directory; callers run `cleanup` on success or `revert` to undo. */
export const publishThemeContents = Effect.fn("EnvironmentTheme.publish")(function* (input: {
  readonly themesDir: string;
  readonly themeId: string;
  readonly raw: string;
  readonly overwrite?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { themeId, raw } = input;
  const publishFailure = (cause: unknown) =>
    new ThemePublishError({ themesDir: input.themesDir, cause });
  yield* fs
    .makeDirectory(input.themesDir, { recursive: true })
    .pipe(Effect.mapError(publishFailure));
  const previouslyPublished = yield* readPublishedThemes(input.themesDir);
  const checkCapacity = Effect.gen(function* () {
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
    let totalBytes = Buffer.byteLength(raw);
    for (const entry of others) {
      totalBytes += Buffer.byteLength(
        (yield* readThemeFileGuarded(path.join(input.themesDir, entry), MAX_THEME_FILE_BYTES)) ??
          "",
      );
    }
    if (others.length >= MAX_THEME_FILES || totalBytes > MAX_THEME_TOTAL_BYTES)
      return yield* new ThemeLibraryError({
        reason: "limit",
        detail:
          "Theme library limit reached (32 files, 192 KiB total). Delete unused published themes first.",
      });
  });
  yield* checkCapacity;

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
        try {
          NodeFS.writeFileSync(fd, raw);
          return NodeFS.fstatSync(fd).ino;
        } finally {
          NodeFS.closeSync(fd);
        }
      } catch (cause) {
        NodeFS.unlinkSync(stagingPath);
        throw cause;
      }
    },
    catch: publishFailure,
  });

  // Keep the destination visible while retaining its inode for rollback.
  const hadPrevious = yield* Effect.try({
    try: () => {
      try {
        if (input.overwrite === false) return false;
        NodeFS.linkSync(destinationPath, backupPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        // FAT and some network filesystems lack hard links; preserve CLI overwrite support.
        if (hardLinksUnavailable(error)) {
          NodeFS.renameSync(destinationPath, backupPath);
          return true;
        }
        throw error;
      }
    },
    catch: publishFailure,
  }).pipe(Effect.onError(() => fs.remove(stagingPath).pipe(Effect.ignoreCause({ log: true }))));

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
    try: () => {
      if (input.overwrite === false) {
        NodeFS.linkSync(stagingPath, destinationPath);
        NodeFS.unlinkSync(stagingPath);
      } else NodeFS.renameSync(stagingPath, destinationPath);
    },
    catch: (cause) =>
      input.overwrite === false && (cause as NodeJS.ErrnoException).code === "EEXIST"
        ? new ThemeLibraryError({ reason: "collision" })
        : input.overwrite === false && hardLinksUnavailable(cause)
          ? new ThemeLibraryError({
              reason: "unsupported",
              detail:
                "Atomic theme creation requires hard links. Move the T3 home to a filesystem that supports hard links, or publish a complete temporary file with an atomic rename.",
              cause,
            })
          : publishFailure(cause),
  }).pipe(Effect.onError(() => revert));

  // A concurrent writer outside this process can still fill the directory after the check above.
  yield* checkCapacity.pipe(Effect.onError(() => revert));
  const visible = yield* readPublishedThemes(input.themesDir).pipe(Effect.onError(() => revert));
  const visibleIds = new Set(visible.map((theme) => theme.id));
  if (!visibleIds.has(themeId) || previouslyPublished.some((theme) => !visibleIds.has(theme.id))) {
    yield* revert;
    return yield* new ThemeLibraryError({
      reason: "limit",
      detail:
        "Theme library limit reached (32 files, 192 KiB total). Delete unused published themes first.",
    });
  }
  return { themeId, revert, cleanup };
});

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
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

  const refreshForClients = refresh.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "could not refresh environment themes; retaining published state",
        cause,
      ).pipe(Effect.andThen(Ref.get(published))),
    ),
  );

  yield* refreshForClients;
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
  const storageError = (cause: unknown) =>
    isThemeLibraryError(cause)
      ? cause
      : new ThemeLibraryError({
          reason: "storage",
          detail:
            "Could not access theme storage. Check file permissions and available disk space.",
          cause,
        });
  const builtins: ReadonlyArray<EnvironmentTheme> = BUILT_IN_THEMES.map((theme) => ({
    id: theme.id,
    version: 1,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
  }));
  const definitions = Effect.map(refresh, (state) => [...builtins, ...state.themes]);
  const list = Effect.map(definitions, (themes) =>
    themes.map(({ id, name, appearance }) => ({
      id,
      name,
      appearance,
      builtin: UNPUBLISHABLE_THEME_IDS.has(id),
    })),
  );
  const read = Effect.fn("EnvironmentTheme.read")(function* (id: string) {
    const theme = (yield* definitions).find((theme) => theme.id === id);
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
      Effect.mapError(
        () =>
          new ThemeLibraryError({
            reason: "invalid",
            detail: "Invalid theme name, appearance, colors or variants.",
          }),
      ),
    );
    const raw = yield* encodeThemeFile(theme).pipe(Effect.mapError(storageError));
    yield* validateThemeFile(raw);
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
    if (exists && (yield* readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES)) === null)
      return yield* new ThemeLibraryError({ reason: "invalid" });
    const published = yield* publishThemeContents({
      themesDir: environmentThemesDir,
      themeId: input.id,
      raw,
      overwrite: input.overwrite,
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
    if (!isEnvironmentThemeId(id)) return yield* new ThemeLibraryError({ reason: "invalid" });
    yield* settings
      .withSettingsSnapshot(
        (current) =>
          Effect.gen(function* () {
            if (current.defaultTheme === id)
              return yield* new ThemeLibraryError({ reason: "default_in_use" });
            yield* Effect.try({
              try: () =>
                NodeFS.unlinkSync(path.join(environmentThemesDir, `${id}${THEME_FILE_SUFFIX}`)),
              catch: (cause) =>
                (cause as NodeJS.ErrnoException).code === "ENOENT"
                  ? new ThemeLibraryError({ reason: "not_found" })
                  : storageError(cause),
            });
          }),
        { requireValidFile: true },
      )
      .pipe(
        Effect.mapError((cause) =>
          isThemeLibraryError(cause)
            ? cause
            : new ThemeLibraryError({
                reason: "storage",
                detail:
                  "Could not read settings. Check settings.json syntax, permissions and disk space.",
                cause,
              }),
        ),
      );
    yield* refresh;
  });
  const setDefault = Effect.fn("EnvironmentTheme.setDefault")(function* (id: string) {
    if (id !== "") yield* read(id);
    yield* settings.setDefaultTheme(id).pipe(
      Effect.mapError(
        (cause) =>
          new ThemeLibraryError({
            reason: cause.operation === "write-managed-setting" ? "managed" : "storage",
            detail:
              cause.operation === "write-managed-setting"
                ? "The environment theme default is locked by managed policy."
                : "Could not update settings. Check settings.json syntax, permissions and disk space.",
            cause,
          }),
      ),
    );
  });

  return {
    list,
    read,
    save: (input) => locked(save(input)),
    duplicate: (input) => locked(duplicate(input)),
    remove: (id) => locked(remove(id)),
    setDefault: (id) => locked(setDefault(id)),
    current: Effect.map(refreshForClients, (state) => state.themes),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refreshForClients;
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
