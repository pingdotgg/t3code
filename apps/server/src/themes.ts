import {
  ThemePaletteConfig,
  ThemePaletteDefinition,
  type ServerConfigIssue,
} from "@t3tools/contracts";
import {
  Cache,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  SchemaGetter,
  Ref,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";

export class ThemesConfigError extends Schema.TaggedErrorClass<ThemesConfigError>()(
  "ThemesConfigError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unable to parse themes config at ${this.configPath}: ${this.detail}`;
  }
}

const RawThemeEntries = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const ThemePaletteConfigJson = Schema.fromJsonString(ThemePaletteConfig);
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const ThemePaletteConfigPrettyJson = ThemePaletteConfigJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

export interface ThemesConfigState {
  readonly themes: readonly ThemePaletteDefinition[];
  readonly issues: readonly ServerConfigIssue[];
}

export interface ThemesChangeEvent {
  readonly themes: readonly ThemePaletteDefinition[];
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid themes configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "themes.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "themes.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

export interface ThemesShape {
  readonly start: Effect.Effect<void, ThemesConfigError>;
  readonly ready: Effect.Effect<void, ThemesConfigError>;
  readonly syncDefaultThemesOnStartup: Effect.Effect<void, ThemesConfigError>;
  readonly loadConfigState: Effect.Effect<ThemesConfigState, ThemesConfigError>;
  readonly getSnapshot: Effect.Effect<ThemesConfigState, ThemesConfigError>;
  readonly streamChanges: Stream.Stream<ThemesChangeEvent>;
}

export class Themes extends ServiceMap.Service<Themes, ThemesShape>()("t3/themes") {}

const makeThemes = Effect.gen(function* () {
  const { themesConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const updateSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ThemesChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ThemesConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (configState: ThemesConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(themesConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new ThemesConfigError({
          configPath: themesConfigPath,
          detail: "failed to access themes config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(themesConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new ThemesConfigError({
          configPath: themesConfigPath,
          detail: "failed to read themes config",
          cause,
        }),
    ),
  );

  const writeConfigAtomically = (themes: readonly ThemePaletteDefinition[]) => {
    const tempPath = `${themesConfigPath}.${process.pid}.${Date.now()}.tmp`;

    return Schema.encodeEffect(ThemePaletteConfigPrettyJson)(themes).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.tap(() => fs.makeDirectory(path.dirname(themesConfigPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, themesConfigPath)),
      Effect.mapError(
        (cause) =>
          new ThemesConfigError({
            configPath: themesConfigPath,
            detail: "failed to write themes config",
            cause,
          }),
      ),
    );
  };

  const loadConfigStateFromDisk = Effect.gen(function* (): Effect.fn.Return<
    ThemesConfigState,
    ThemesConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { themes: [], issues: [] };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = Schema.decodeUnknownExit(RawThemeEntries)(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        themes: [],
        issues: [malformedConfigIssue(detail)],
      };
    }

    const themes: ThemePaletteDefinition[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedTheme = Schema.decodeUnknownExit(ThemePaletteDefinition)(entry);
      if (decodedTheme._tag === "Failure") {
        const detail = Cause.pretty(decodedTheme.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid theme entry", {
          path: themesConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      themes.push(decodedTheme.value);
    }

    return { themes, issues };
  });

  const configCacheKey = "themes" as const;
  const configCache = yield* Cache.make<
    typeof configCacheKey,
    ThemesConfigState,
    ThemesConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });
  const loadConfigStateFromCacheOrDisk = Cache.get(configCache, configCacheKey);

  const revalidateAndEmit = updateSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(configCache, configCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultThemesOnStartup = updateSemaphore.withPermits(1)(
    Effect.gen(function* () {
      if (yield* readConfigExists) {
        yield* Cache.invalidate(configCache, configCacheKey);
        return;
      }

      yield* writeConfigAtomically([]);
      yield* Cache.invalidate(configCache, configCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const themesConfigDir = path.dirname(themesConfigPath);
    const themesConfigFile = path.basename(themesConfigPath);
    const themesConfigPathResolved = path.resolve(themesConfigPath);

    yield* fs.makeDirectory(themesConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ThemesConfigError({
            configPath: themesConfigPath,
            detail: "failed to prepare themes config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    yield* Stream.runForEach(fs.watch(themesConfigDir), (event) => {
      const isTargetConfigEvent =
        event.path === themesConfigFile ||
        event.path === themesConfigPath ||
        path.resolve(themesConfigDir, event.path) === themesConfigPathResolved;
      if (!isTargetConfigEvent) {
        return Effect.void;
      }
      return revalidateAndEmitSafely;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultThemesOnStartup;
      yield* Cache.invalidate(configCache, configCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultThemesOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ThemesShape;
});

export const ThemesLive = Layer.effect(Themes, makeThemes);
