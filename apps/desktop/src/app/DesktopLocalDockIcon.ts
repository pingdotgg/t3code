import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Fork: macOS shows an app's dark icon only when the system icon style is Dark,
// so the local build swaps its Dock icon to match the app theme while it runs.
export const register = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* Effect.serviceOption(DesktopAssets.DesktopAssets);
  if (
    environment.platform !== "darwin" ||
    environment.branding.stageLabel !== "Local" ||
    Option.isNone(assets)
  ) {
    return;
  }
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const sync = Effect.gen(function* () {
    const dark = yield* electronTheme.shouldUseDarkColors;
    const iconPath = yield* assets.value.resolveResourcePath(
      dark ? "dock-icon-dark.png" : "dock-icon-light.png",
    );
    if (Option.isSome(iconPath)) yield* electronApp.setDockIcon(iconPath.value);
  }).pipe(Effect.ignore, Effect.withSpan("desktop.localDockIcon.sync"));

  const runSync = Effect.runPromiseWith(yield* Effect.context<never>());
  yield* sync;
  yield* electronTheme.onUpdated(() => {
    void runSync(sync);
  });
});
