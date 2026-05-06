import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  type DesktopSettings,
  DEFAULT_DESKTOP_SETTINGS,
  readDesktopSettingsEffect,
  writeDesktopSettingsEffect,
} from "../desktopSettings.ts";
import { DesktopEnvironment } from "../desktopEnvironment.ts";

export type DesktopSettingsPersistenceError = PlatformError.PlatformError | Schema.SchemaError;

export interface DesktopSettingsStateShape {
  readonly get: Effect.Effect<DesktopSettings>;
  readonly set: (settings: DesktopSettings) => Effect.Effect<void>;
  readonly load: Effect.Effect<DesktopSettings, never, FileSystem.FileSystem | DesktopEnvironment>;
  readonly update: (
    f: (settings: DesktopSettings) => DesktopSettings,
  ) => Effect.Effect<DesktopSettings>;
  readonly updatePersisted: (
    f: (settings: DesktopSettings) => DesktopSettings,
  ) => Effect.Effect<
    DesktopSettings,
    DesktopSettingsPersistenceError,
    FileSystem.FileSystem | Path.Path | DesktopEnvironment
  >;
  readonly modifyPersisted: <A>(
    f: (settings: DesktopSettings) => readonly [A, DesktopSettings],
  ) => Effect.Effect<
    A,
    DesktopSettingsPersistenceError,
    FileSystem.FileSystem | Path.Path | DesktopEnvironment
  >;
}

export class DesktopSettingsState extends Context.Service<
  DesktopSettingsState,
  DesktopSettingsStateShape
>()("t3/desktop/SettingsState") {}

export const layer = Layer.effect(
  DesktopSettingsState,
  Effect.gen(function* () {
    const settingsRef = yield* SynchronizedRef.make(DEFAULT_DESKTOP_SETTINGS);

    const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
      SynchronizedRef.updateAndGet(settingsRef, f);
    const modifyPersisted = <A>(f: (settings: DesktopSettings) => readonly [A, DesktopSettings]) =>
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment;
        return yield* SynchronizedRef.modifyEffect(settingsRef, (settings) => {
          const [result, nextSettings] = f(settings);
          if (nextSettings === settings) {
            return Effect.succeed([result, settings] as const);
          }

          return writeDesktopSettingsEffect(environment.desktopSettingsPath, nextSettings).pipe(
            Effect.as([result, nextSettings] as const),
          );
        });
      });

    return DesktopSettingsState.of({
      get: SynchronizedRef.get(settingsRef),
      set: (settings) => SynchronizedRef.set(settingsRef, settings),
      load: Effect.gen(function* () {
        const environment = yield* DesktopEnvironment;
        const settings = yield* readDesktopSettingsEffect(
          environment.desktopSettingsPath,
          environment.appVersion,
        );
        return yield* SynchronizedRef.setAndGet(settingsRef, settings);
      }),
      update,
      updatePersisted: (f) =>
        modifyPersisted((settings) => {
          const nextSettings = f(settings);
          return [nextSettings, nextSettings] as const;
        }),
      modifyPersisted,
    });
  }),
);
