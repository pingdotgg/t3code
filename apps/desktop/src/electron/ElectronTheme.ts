import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronThemeSetSourceError extends Schema.TaggedError<ElectronThemeSetSourceError>()(
  "ElectronThemeSetSourceError",
  {
    source: DesktopThemeSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly systemTheme: Effect.Effect<{ appearance: "light" | "dark"; accent: string | null }>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  systemTheme: Effect.sync(() => {
    let accent: string | null = null;
    try {
      const rgba = Electron.systemPreferences.getAccentColor();
      if (/^[a-f\d]{8}$/i.test(rgba) && rgba.slice(6).toLowerCase() !== "00")
        accent = `#${rgba.slice(0, 6).toLowerCase()}`;
    } catch {
      // Desktop sessions without an accent preference retain the palette's accent.
    }
    return {
      appearance: Electron.nativeTheme.shouldUseDarkColors ? "dark" : "light",
      accent,
    };
  }),
  setSource: (theme) =>
    Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
      },
      catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
    }),
  onUpdated: (listener) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        Electron.nativeTheme.on("updated", listener);
        Electron.systemPreferences.on("accent-color-changed", listener);
        const notifications =
          platform === "darwin"
            ? ["AppleColorPreferencesChangedNotification", "AppleAquaColorVariantChanged"].map(
                (notification) =>
                  Electron.systemPreferences.subscribeNotification(notification, listener),
              )
            : [];
        return notifications;
      }),
      (notifications) =>
        Effect.suspend(() => {
          Electron.nativeTheme.removeListener("updated", listener);
          Electron.systemPreferences.removeListener("accent-color-changed", listener);
          for (const notification of notifications)
            Electron.systemPreferences.unsubscribeNotification(notification);
          return Effect.void;
        }),
    ).pipe(Effect.asVoid),
});

export const layer = Layer.succeed(ElectronTheme, make);
