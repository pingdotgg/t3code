import { DEFAULT_APP_ICON_ID, type AppIconId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopAppIcon extends Context.Service<
  DesktopAppIcon,
  {
    readonly apply: (
      appIcon: AppIconId,
    ) => Effect.Effect<void, DesktopAssets.DesktopAssetProbeError>;
    readonly applyStored: Effect.Effect<void, DesktopAssets.DesktopAssetProbeError>;
  }
>()("@t3tools/desktop/app/DesktopAppIcon") {}

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const apply = Effect.fn("desktop.appIcon.apply")(function* (appIcon: AppIconId) {
    const iconPath = yield* assets.resolveAppIconPath(appIcon, environment.platform);
    if (Option.isNone(iconPath)) return;

    if (environment.platform === "darwin") {
      yield* electronApp.setDockIcon(iconPath.value);
    }
    yield* electronWindow.syncAllAppearance((window) =>
      Effect.sync(() => {
        window.setIcon(iconPath.value);
      }),
    );
  });

  return DesktopAppIcon.of({
    apply,
    applyStored: clientSettings.get.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => apply(DEFAULT_APP_ICON_ID),
          onSome: (settings) => apply(settings.appIcon),
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopAppIcon, make);
