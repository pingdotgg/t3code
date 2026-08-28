/**
 * EnvironmentTheme - palettes this machine publishes for clients to follow.
 *
 * A desktop that retints its apps when the user switches system theme writes
 * `<stateDir>/themes/<id>.json`; this service watches that directory and
 * streams the published set to connected clients so a theme change lands
 * without a restart. The filename is the theme id: it stays stable while the
 * machine rewrites the colors underneath, so `defaultTheme` and a client\'s
 * selection keep pointing at the same theme across recolors. Theming is
 * cosmetic, so every failure here degrades to "not published" rather than
 * propagating.
 *
 * @module EnvironmentTheme
 */
import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

/** The published set with the sequence number it was observed at. */
interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    /**
     * The set published right now, read from disk rather than from the
     * watcher\'s last observation: a client connecting must see what the
     * machine actually publishes even if it missed a filesystem event.
     */
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /**
     * The current set followed by every change, with repeats dropped. The
     * subscription is acquired before the current set is read, so a publish
     * landing while a client connects is delivered rather than lost.
     */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

export const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  /**
   * Every observed set carries a sequence number, so a subscriber can drop
   * queued events that predate the snapshot it started from. Without it a
   * publish landing between subscribing and reading replays after the newer
   * value and walks clients backwards onto stale colors.
   */
  const changes = yield* PubSub.unbounded<PublishedThemes>();
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  /** A file that is missing, unreadable, malformed, invalid, or misnamed is
   * simply not published; the rest of the set is unaffected. */
  const readThemes = Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(environmentThemesDir)
      .pipe(Effect.orElseSucceed((): Array<string> => []));

    const themes: Array<EnvironmentTheme> = [];
    for (const entry of entries.toSorted()) {
      if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
      const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
      if (!isEnvironmentThemeId(id)) continue;

      const filePath = `${environmentThemesDir}/${entry}`;
      const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
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
      themes.push({ id, ...file });
    }
    return themes;
  });

  /**
   * Reads the directory and folds it into the sequenced state, publishing only
   * a genuine change. Every reader goes through here, so the snapshot a client
   * connects on and the events it then receives come from one ordered source
   * rather than from disk and the queue independently.
   */
  const refresh = Effect.gen(function* () {
    const themes = yield* readThemes;
    // Structural equality over the whole decoded value: a hand-rolled field
    // list here silently drops republishes for any field it forgets.
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
  });

  // The directory is created up front so the watcher has something to attach
  // to before the first publisher writes into it.
  yield* fs
    .makeDirectory(environmentThemesDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  // Debounced for the same reason settings watching is: a theme script emits
  // several events per save and `fs.watch` can fire before the content is
  // flushed. Every event triggers a full re-read, so no event needs filtering.
  const watchEvents = fs.watch(environmentThemesDir).pipe(Stream.debounce(Duration.millis(100)));

  // Seeds the dedupe so a watch event that reports no actual change (a touch,
  // a rewrite with identical contents) does not retint every client.
  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  return {
    current: Effect.map(refresh, (state) => state.themes),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first so nothing published during the read is missed,
          // then drop anything the snapshot already accounts for.
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
