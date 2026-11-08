import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopQuickComposer from "./DesktopQuickComposer.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  { readonly initialize: Effect.Effect<void> }
>()("@t3tools/desktop/window/DesktopTray") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const quickComposer = yield* DesktopQuickComposer.DesktopQuickComposer;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let tray: Electron.Tray | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => tray?.destroy()));

  const toggleMain = Effect.gen(function* () {
    const main = yield* electronWindow.main;
    if (Option.isSome(main) && main.value.isVisible() && !main.value.isMinimized()) {
      main.value.hide();
      return;
    }
    yield* desktopWindow.activate.pipe(Effect.ignoreCause);
  });

  return DesktopTray.of({
    initialize: Effect.gen(function* () {
      if (tray !== undefined) return;
      const iconPath = (yield* assets.iconPaths).png;
      if (Option.isNone(iconPath)) return;
      const size = environment.platform === "darwin" ? 16 : 24;
      tray = new Electron.Tray(
        Electron.nativeImage.createFromPath(iconPath.value).resize({ width: size, height: size }),
      );
      tray.setToolTip(environment.displayName);
      tray.setContextMenu(
        Electron.Menu.buildFromTemplate([
          {
            label: `Show/Hide ${environment.displayName}`,
            click: () => runFork(toggleMain),
          },
          {
            label: "Quick Composer",
            accelerator: DesktopQuickComposer.QUICK_COMPOSER_SHORTCUT,
            registerAccelerator: false,
            click: () => runFork(quickComposer.open),
          },
          { type: "separator" },
          { label: `Quit ${environment.displayName}`, click: () => runFork(electronApp.quit) },
        ]),
      );
      // Linux trays rarely report clicks; the menu above covers them.
      tray.on("click", () => runFork(toggleMain));
    }).pipe(Effect.withSpan("desktop.tray.initialize")),
  });
});

export const layer = Layer.effect(DesktopTray, make);
