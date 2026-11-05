import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";

export class DesktopTrayError extends Schema.TaggedError<DesktopTrayError>()("DesktopTrayError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not enable background mode. The system tray is unavailable; closing the window will use the normal behavior.";
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly initialize: (open: Effect.Effect<void>) => Effect.Effect<void>;
    readonly configure: (enabled: boolean) => Effect.Effect<void, DesktopTrayError>;
    readonly shouldHideOnClose: Effect.Effect<boolean>;
    readonly updateBadge: (badge: {
      readonly count: number;
      readonly image: string | null;
    }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const state = yield* DesktopState.DesktopState;
  const app = yield* ElectronApp.ElectronApp;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const mutex = yield* Semaphore.make(1);
  let tray: Electron.Tray | undefined;
  let baseImage: Electron.NativeImage | undefined;
  let badge = { count: 0, image: null as string | null };
  let open = Effect.void;
  let initialized = false;

  const activate = () => {
    runFork(
      Ref.get(state.quitting).pipe(
        Effect.flatMap((quitting) => (quitting ? Effect.void : open)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not reopen the desktop window", cause),
        ),
      ),
    );
  };
  const refreshBadge = () => {
    if (!tray || !baseImage) return;
    const image =
      badge.count > 0 && badge.image
        ? Electron.nativeImage.createFromDataURL(badge.image)
        : undefined;
    tray.setImage(
      environment.platform !== "darwin" && image && !image.isEmpty() ? image : baseImage,
    );
    tray.setToolTip(
      badge.count > 0
        ? `${environment.displayName}: ${badge.count} threads with new notifications`
        : environment.displayName,
    );
    if (environment.platform === "darwin")
      tray.setTitle(badge.count > 0 ? String(badge.count) : "");
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      tray?.destroy();
      tray = undefined;
    }),
  );

  return DesktopTray.of({
    initialize: Effect.fn("desktop.tray.initialize")(function (onOpen) {
      return Effect.sync(() => {
        open = onOpen;
        initialized = true;
      });
    }),
    configure: Effect.fn("desktop.tray.configure")(function* (enabled) {
      if (!enabled) {
        if (!tray) return;
        if (!(yield* Ref.get(state.quitting))) yield* open;
        yield* Effect.sync(() => {
          tray?.destroy();
          tray = undefined;
        });
        return;
      }
      if (tray || (yield* Ref.get(state.quitting))) return;
      const iconPaths = yield* assets.iconPaths;
      yield* Effect.try({
        try: () => {
          if (!initialized)
            throw new Error("Desktop tray must be initialized after Electron is ready.");
          const iconPath = Option.getOrThrow(
            environment.platform === "win32"
              ? Option.orElse(iconPaths.ico, () => iconPaths.png)
              : iconPaths.png,
          );
          baseImage = Electron.nativeImage
            .createFromPath(iconPath)
            .resize({ width: 16, height: 16 });
          if (baseImage.isEmpty()) throw new Error("The desktop tray icon is empty.");
          const created = new Electron.Tray(baseImage);
          try {
            created.setContextMenu(
              Electron.Menu.buildFromTemplate([
                { label: `Open ${environment.displayName}`, click: activate },
                { type: "separator" },
                { label: `Quit ${environment.displayName}`, click: () => runFork(app.quit) },
              ]),
            );
            if (environment.platform !== "darwin") created.on("click", activate);
            tray = created;
            refreshBadge();
          } catch (cause) {
            tray = undefined;
            created.destroy();
            throw cause;
          }
        },
        catch: (cause) => new DesktopTrayError({ cause }),
      });
    }, mutex.withPermits(1)),
    shouldHideOnClose: Effect.sync(() => tray !== undefined && !tray.isDestroyed()).pipe(
      Effect.flatMap((available) =>
        Ref.get(state.quitting).pipe(Effect.map((quitting) => available && !quitting)),
      ),
    ),
    updateBadge: Effect.fn("desktop.tray.updateBadge")(function (value) {
      return Effect.sync(() => {
        badge = value;
        refreshBadge();
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not update the system tray badge", cause),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DesktopTray, make);
