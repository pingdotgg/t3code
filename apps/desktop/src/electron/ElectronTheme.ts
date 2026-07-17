import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronThemeSetSourceError extends Schema.TaggedErrorClass<ElectronThemeSetSourceError>()(
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

export const isElectronThemeSetSourceError = Schema.is(ElectronThemeSetSourceError);

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  setSource: (theme) =>
    Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
      },
      catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
    }),
  onUpdated: (listener) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        Electron.nativeTheme.on("updated", listener);
        return Effect.void;
      }),
      () =>
        Effect.suspend(() => {
          Electron.nativeTheme.removeListener("updated", listener);
          return Effect.void;
        }),
    ),
});

export const layer = Layer.succeed(ElectronTheme, make);
