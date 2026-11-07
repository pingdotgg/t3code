import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (enabled: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const configureMutex = yield* Semaphore.make(1);
  let tray: Electron.Tray | null = null;

  const activate = () => {
    void runPromise(
      desktopWindow.activate.pipe(
        Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
      ),
    );
  };

  const destroyTray = Effect.sync(() => {
    const previous = tray;
    tray = null;
    previous?.destroy();
  });

  yield* Effect.addFinalizer(() =>
    Ref.set(state.closeToTray, false).pipe(Effect.andThen(destroyTray)),
  );

  const applyEnabled = Effect.gen(function* () {
    if (tray !== null || environment.platform === "darwin") return;
    const iconPaths = yield* assets.iconPaths;
    // Tray icons need a real image; a missing or undecodable asset leaves the
    // feature off so window close keeps its normal quit behavior.
    const created = yield* Effect.try(() => {
      if (environment.platform === "win32") {
        const icoPath = Option.getOrNull(iconPaths.ico);
        return icoPath === null ? null : new Electron.Tray(icoPath);
      }
      const pngPath = Option.getOrNull(iconPaths.png);
      if (pngPath === null) return null;
      const image = Electron.nativeImage.createFromPath(pngPath).resize({ width: 32, height: 32 });
      return image.isEmpty() ? null : new Electron.Tray(image);
    }).pipe(
      Effect.catch((cause) =>
        logWarning("failed to create the system tray icon", { cause }).pipe(Effect.as(undefined)),
      ),
    );
    if (created === undefined) return;
    if (created === null) {
      yield* logWarning("no tray icon image is available; close to tray stays off");
      return;
    }
    tray = created;
    tray.setToolTip(environment.displayName);
    tray.setContextMenu(
      Electron.Menu.buildFromTemplate([
        { label: `Open ${environment.displayName}`, click: activate },
        { type: "separator" },
        {
          label: `Quit ${environment.displayName}`,
          click: () => {
            void runPromise(electronApp.quit);
          },
        },
      ]),
    );
    tray.on("click", activate);
    yield* Ref.set(state.closeToTray, true);
  }).pipe(
    Effect.catchCause((cause) =>
      Ref.set(state.closeToTray, false).pipe(
        Effect.andThen(
          destroyTray.pipe(
            Effect.catchCause((cleanupCause) =>
              logWarning("failed to destroy the unfinished tray", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(logWarning("failed to configure the system tray", { cause })),
      ),
    ),
  );

  const applyDisabled = Effect.gen(function* () {
    if (tray === null) return;
    yield* Ref.set(state.closeToTray, false);
    yield* destroyTray;
  });

  return DesktopTray.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) =>
        Option.isSome(stored) && stored.value.keepRunningInTray
          ? configureMutex.withPermits(1)(applyEnabled)
          : Effect.void,
      ),
      Effect.catch((error) =>
        logWarning("could not read client settings for the tray toggle", {
          message: error.message,
        }),
      ),
      Effect.withSpan("desktop.tray.initialize"),
    ),
    configure: Effect.fn("desktop.tray.configure")(function* (enabled) {
      yield* configureMutex
        .withPermits(1)(enabled ? applyEnabled : applyDisabled)
        .pipe(
          Effect.catchCause((cause) => logWarning("failed to update the system tray", { cause })),
        );
    }),
  });
});

export const layer = Layer.effect(DesktopTray, make);
