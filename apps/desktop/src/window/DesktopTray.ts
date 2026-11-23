import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import { msg } from "gt-i18n";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const { logWarning } = makeComponentLogger("desktop-tray");

class DesktopTrayCreateError extends Schema.TaggedError<DesktopTrayCreateError>()(
  "DesktopTrayCreateError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create system tray icon.";
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly sync: Effect.Effect<void>;
    readonly destroy: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const resolveTrayImage = (
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): Option.Option<Electron.NativeImage> => {
  const candidate =
    platform === "win32"
      ? Option.orElse(iconPaths.ico, () => iconPaths.png)
      : Option.orElse(iconPaths.png, () => iconPaths.ico);
  if (Option.isNone(candidate)) return Option.none();
  const image = Electron.nativeImage.createFromPath(candidate.value);
  if (image.isEmpty()) return Option.none();
  if (platform === "darwin") {
    return Option.some(image.resize({ width: 18, height: 18 }));
  }
  if (platform === "linux") {
    return Option.some(image.resize({ width: 22, height: 22 }));
  }
  return Option.some(image);
};

/** @public */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  let tray: Electron.Tray | null = null;

  const destroy = Effect.sync(() => {
    if (tray !== null && !tray.isDestroyed()) {
      tray.destroy();
    }
    tray = null;
  }).pipe(Effect.withSpan("desktop.tray.destroy"));

  const revealMain = () => {
    void runPromise(
      desktopWindow.revealOrCreateMain.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          logWarning("failed to reveal window from system tray", { cause }),
        ),
      ),
    );
  };

  const sync = Effect.gen(function* () {
    const settings = yield* desktopSettings.get;
    if (!settings.backgroundServiceEnabled) {
      yield* destroy;
      return;
    }
    if (tray !== null && !tray.isDestroyed()) {
      return;
    }
    const iconPaths = yield* assets.iconPaths;
    const image = resolveTrayImage(iconPaths, environment.platform);
    if (Option.isNone(image)) {
      yield* logWarning("could not load tray icon image");
      return;
    }
    yield* Effect.try({
      try: () => {
        const nextTray = new Electron.Tray(image.value);
        nextTray.setToolTip(environment.displayName);
        nextTray.setContextMenu(
          Electron.Menu.buildFromTemplate([
            {
              label: m(msg("Open T3 Code")),
              click: revealMain,
            },
            { type: "separator" },
            {
              label: m(msg("Quit T3 Code")),
              click: () => {
                void runPromise(electronApp.quit);
              },
            },
          ]),
        );
        if (environment.platform !== "darwin") {
          nextTray.on("click", revealMain);
          nextTray.on("double-click", revealMain);
        }
        tray = nextTray;
      },
      catch: (cause) => new DesktopTrayCreateError({ cause }),
    }).pipe(Effect.catch((error) => logWarning(error.message, { cause: error.cause })));
  }).pipe(Effect.withSpan("desktop.tray.sync"));

  yield* Effect.addFinalizer(() => destroy);

  return DesktopTray.of({ sync, destroy });
});

export const layer = Layer.effect(DesktopTray, make);
