import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as DesktopLoginItem from "../app/DesktopLoginItem.ts";
import * as DesktopTray from "../app/DesktopTray.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

type PreferencesError =
  | DesktopClientSettings.DesktopClientSettingsReadError
  | DesktopClientSettings.DesktopClientSettingsWriteError
  | DesktopLoginItem.DesktopLoginItemError
  | DesktopTray.DesktopTrayError;

export class DesktopClientPreferences extends Context.Service<
  DesktopClientPreferences,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>, PreferencesError>;
    readonly set: (settings: ClientSettings) => Effect.Effect<void, PreferencesError>;
  }
>()("@t3tools/desktop/settings/DesktopClientPreferences") {}

const make = Effect.gen(function* () {
  const storage = yield* DesktopClientSettings.DesktopClientSettings;
  const loginItem = yield* DesktopLoginItem.DesktopLoginItem;
  const tray = yield* DesktopTray.DesktopTray;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const mutex = yield* Semaphore.make(1);

  return DesktopClientPreferences.of({
    get: Effect.gen(function* () {
      const saved = yield* storage.get;
      const current = Option.getOrElse(saved, () => DEFAULT_CLIENT_SETTINGS);
      const openAtLogin = yield* loginItem.getEnabled;
      if (current.openAtLogin === openAtLogin) return saved;
      // OS startup controls can change independently; persist the baseline before the next edit.
      const reconciled = { ...current, openAtLogin };
      yield* storage.set(reconciled);
      return Option.some(reconciled);
    }).pipe(mutex.withPermits(1), Effect.withSpan("desktop.clientPreferences.get")),
    set: Effect.fn("desktop.clientPreferences.set")(function* (settings) {
      const previous = Option.getOrElse(yield* storage.get, () => DEFAULT_CLIENT_SETTINGS);
      const loginChanged = previous.openAtLogin !== settings.openAtLogin;
      const previousLoginEnabled = loginChanged ? yield* loginItem.getEnabled : false;
      let loginAttempted = false;
      yield* Effect.gen(function* () {
        yield* tray.configure(settings.keepRunningInBackground);
        if (loginChanged) {
          loginAttempted = true;
          yield* loginItem.configure(settings.openAtLogin);
        }
        yield* storage.set(settings);
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            if (loginAttempted)
              yield* loginItem.configure(previousLoginEnabled).pipe(Effect.ignore);
            yield* tray.configure(previous.keepRunningInBackground).pipe(Effect.ignore);
          }),
        ),
      );
      yield* snapShot.configure(settings);
    }, mutex.withPermits(1)),
  });
});

export const layer = Layer.effect(DesktopClientPreferences, make);
