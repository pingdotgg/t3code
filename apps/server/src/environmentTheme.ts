// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
import * as NodeFS from "node:fs";

import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
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
import { ServerSettingsService } from "./serverSettings.ts";

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

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

const APPLY_FAILURES = {
  "invalid-id":
    "is not a valid theme id. Use lowercase letters, digits, and hyphens, and not a built-in name.",
  "unknown-id": "is not a built-in or published theme.",
  "no-colors": "has no colors. Give canvas and accent, or at least one color role.",
  "remote-css":
    "has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.",
  "too-large": `is larger than ${MAX_THEME_FILE_BYTES} bytes.`,
  "not-published": "could not be published. The themes directory may be full or not writable.",
  "not-selected": "was not made the environment theme, because the settings could not be saved.",
} as const;

export class EnvironmentThemeApplyError extends Schema.TaggedError<EnvironmentThemeApplyError>()(
  "EnvironmentThemeApplyError",
  {
    themeId: Schema.String,
    reason: Schema.Literals([
      "invalid-id",
      "unknown-id",
      "no-colors",
      "remote-css",
      "too-large",
      "not-published",
      "not-selected",
    ]),
    known: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const known = this.known ? ` Available: ${this.known.join(", ")}.` : "";
    return `Theme "${this.themeId}" ${APPLY_FAILURES[this.reason]}${known}`;
  }
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /**
     * Makes `themeId` the environment theme, so connected clients switch to it. With `theme`,
     * first publishes that file under the id, replacing one already there.
     */
    readonly apply: (input: {
      readonly themeId: string;
      readonly theme?: EnvironmentThemeFile | undefined;
    }) => Effect.Effect<void, EnvironmentThemeApplyError>;

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

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettingsService;
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

  const publish = Effect.fnUntraced(function* (themeId: string, file: EnvironmentThemeFile) {
    const fail = (reason: EnvironmentThemeApplyError["reason"], cause?: unknown) =>
      new EnvironmentThemeApplyError({ themeId, reason, cause });
    if (UNPUBLISHABLE_THEME_IDS.has(themeId)) return yield* fail("invalid-id");
    if (!environmentThemeFileHasColors(file)) return yield* fail("no-colors");
    if (file.css !== undefined && themeCssLoadsRemoteFiles(file.css)) {
      return yield* fail("remote-css");
    }
    const contents = yield* encodeEnvironmentThemeFileJson(file).pipe(
      Effect.mapError((cause) => fail("not-published", cause)),
    );
    if (Buffer.byteLength(contents) > MAX_THEME_FILE_BYTES) return yield* fail("too-large");

    const destination = `${environmentThemesDir}/${themeId}${THEME_FILE_SUFFIX}`;
    // The watcher reads only .json names, so it never sees a half-written file.
    const staging = `${destination}.staging-${process.pid}`;
    const replace = (next: string) =>
      fs.writeFileString(staging, next).pipe(
        Effect.andThen(fs.rename(staging, destination)),
        Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      );

    yield* publishSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // The guarded reader does not block on a FIFO and does not follow a symlink.
        const previous = Option.fromNullOr(readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES));
        const servedBefore = (yield* refresh).themes.map((theme) => theme.id);
        yield* fs.makeDirectory(environmentThemesDir, { recursive: true }).pipe(
          Effect.andThen(replace(contents)),
          Effect.mapError((cause) => fail("not-published", cause)),
        );
        // The reader stops at its count and size limits, so this file can go unserved, or it can
        // push another theme out. Both count as a failed publish.
        const served = new Set((yield* refresh).themes.map((theme) => theme.id));
        if (served.has(themeId) && servedBefore.every((id) => served.has(id))) return;
        // Put back what was there, so a rejected publish does not take a working theme away.
        yield* Option.match(previous, {
          onNone: () => fs.remove(destination, { force: true }),
          onSome: replace,
        }).pipe(Effect.ignore);
        yield* refresh;
        return yield* fail("not-published");
      }),
    );
  });

  const apply: EnvironmentThemeService["Service"]["apply"] = Effect.fn(
    "EnvironmentThemeService.apply",
  )(function* ({ themeId, theme }) {
    const fail = (
      reason: EnvironmentThemeApplyError["reason"],
      detail?: { readonly known?: ReadonlyArray<string>; readonly cause?: unknown },
    ) => new EnvironmentThemeApplyError({ themeId, reason, ...detail });
    if (!isEnvironmentThemeId(themeId)) return yield* fail("invalid-id");
    if (theme !== undefined) {
      yield* publish(themeId, theme);
    } else {
      const known = [...BUILT_IN_THEME_IDS, ...(yield* refresh).themes.map(({ id }) => id)];
      if (!known.includes(themeId)) return yield* fail("unknown-id", { known });
    }
    // The timestamp makes clients apply the theme again when its id did not change.
    yield* settings
      .updateSettings({
        defaultTheme: themeId,
        defaultThemeSetAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.mapError((cause) => fail("not-selected", { cause })));
  });

  return {
    current: Effect.map(refresh, (state) => state.themes),
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
