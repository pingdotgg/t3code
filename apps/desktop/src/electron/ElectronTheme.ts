import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import { watchLinuxColorScheme, type LinuxColorScheme } from "./LinuxColorScheme.ts";

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
    /**
     * The OS scheme while the app forces its own theme, which web content would otherwise
     * inherit; `null` while web content already follows the OS, or the OS scheme is unknown.
     */
    readonly systemColorScheme: Effect.Effect<LinuxColorScheme>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    /** Also runs when the OS scheme changes behind a forced theme. */
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

type WatchSystemColorScheme = (onChange: (scheme: LinuxColorScheme) => void) => {
  readonly stop: () => void;
};

// The global default, unlike NSApp.effectiveAppearance, is not overridden by themeSource.
const readMacColorScheme = (): LinuxColorScheme =>
  Electron.systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark"
    ? "dark"
    : "light";

const watchMacColorScheme: WatchSystemColorScheme = (onChange) => {
  const id = Electron.systemPreferences.subscribeNotification(
    "AppleInterfaceThemeChangedNotification",
    () => onChange(readMacColorScheme()),
  );
  onChange(readMacColorScheme());
  return { stop: () => Electron.systemPreferences.unsubscribeNotification(id) };
};

export const makeWith = Effect.fn("ElectronTheme.make")(function* (
  watchSystemColorScheme: WatchSystemColorScheme | undefined,
  resolvesSystemSource = true,
) {
  let source: DesktopTheme = Electron.nativeTheme.themeSource;
  let systemScheme: LinuxColorScheme = null;
  const listeners = new Set<() => void>();
  // On Linux, Electron reads the desktop color scheme once and then ignores the settings
  // portal (electron/electron#48736), so "system" is resolved from the portal directly.
  const apply = () => {
    Electron.nativeTheme.themeSource =
      resolvesSystemSource && source === "system" ? (systemScheme ?? source) : source;
  };

  if (watchSystemColorScheme) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          return watchSystemColorScheme((scheme) => {
            const changed = scheme !== systemScheme;
            systemScheme = scheme;
            if (resolvesSystemSource) apply();
            // Under a forced theme nativeTheme does not see the change.
            if (changed && source !== "system") for (const listener of listeners) listener();
          });
        } catch {
          return undefined;
        }
      }),
      (watcher) => Effect.sync(() => watcher?.stop()),
    );
  }

  return ElectronTheme.of({
    shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
    systemColorScheme: Effect.sync(() => (source === "system" ? null : systemScheme)),
    setSource: Effect.fn("ElectronTheme.setSource")(function (theme) {
      return Effect.try({
        try: () => {
          source = theme;
          apply();
        },
        catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
      });
    }),
    onUpdated: Effect.fn("ElectronTheme.onUpdated")(function (listener) {
      return Effect.acquireRelease(
        Effect.suspend(() => {
          Electron.nativeTheme.on("updated", listener);
          listeners.add(listener);
          return Effect.void;
        }),
        () =>
          Effect.suspend(() => {
            Electron.nativeTheme.removeListener("updated", listener);
            listeners.delete(listener);
            return Effect.void;
          }),
      );
    }),
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") return yield* makeWith(watchLinuxColorScheme);
  // macOS reports its scheme without overriding Electron's own system appearance.
  if (platform === "darwin") return yield* makeWith(watchMacColorScheme, false);
  return yield* makeWith(undefined);
});

export const layer = Layer.effect(ElectronTheme, make);
