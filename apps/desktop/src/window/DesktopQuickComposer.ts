import type { DesktopQuickComposerLaunch } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

// ponytail: fixed accelerator; make it a client setting once someone needs to rebind it.
// Wayland sessions ignore Electron global shortcuts, so the tray item is the way in there.
export const QUICK_COMPOSER_SHORTCUT = "CommandOrControl+Shift+Space";
// Must match the hash route in apps/web/src/routes/quick-composer.tsx.
const QUICK_COMPOSER_HASH = "#/quick-composer";
const WIDTH = 680;
const HEIGHT = 196;
// Down from the top of the work area, like Spotlight.
const TOP_FRACTION = 0.22;

export class DesktopQuickComposer extends Context.Service<
  DesktopQuickComposer,
  {
    readonly initialize: Effect.Effect<void>;
    readonly open: Effect.Effect<void>;
    readonly hide: (senderId: number) => Effect.Effect<void>;
    readonly submit: (senderId: number, launch: DesktopQuickComposerLaunch) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopQuickComposer") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-quick-composer");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let composer: Electron.BrowserWindow | undefined;
  let shortcutRegistered = false;

  const live = () => (composer !== undefined && !composer.isDestroyed() ? composer : undefined);

  // The hidden composer would otherwise keep the app alive after the last real window closes.
  const destroyIfAlone = () => {
    const window = live();
    if (window === undefined || environment.platform === "darwin") return;
    if (Electron.BrowserWindow.getAllWindows().every((other) => other === window)) {
      window.destroy();
    }
  };
  const onWindowCreated = (_event: Electron.Event, window: Electron.BrowserWindow) => {
    if (window !== composer) window.once("closed", destroyIfAlone);
  };

  const create = Effect.gen(function* () {
    const window = yield* electronWindow.create(
      {
        width: WIDTH,
        height: HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        title: environment.displayName,
        webPreferences: {
          preload: environment.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
      { auxiliary: true },
    );
    composer = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (composer === window) composer = undefined;
    });
    void window
      .loadURL(`${getDesktopUrl(environment.isDevelopment)}${QUICK_COMPOSER_HASH}`)
      .catch(() => undefined);
    return window;
  });

  const show = (window: Electron.BrowserWindow) => {
    const { workArea } = Electron.screen.getDisplayNearestPoint(
      Electron.screen.getCursorScreenPoint(),
    );
    window.setPosition(
      Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      Math.round(workArea.y + workArea.height * TOP_FRACTION),
    );
    window.show();
    window.focus();
  };

  const open = Effect.gen(function* () {
    show(live() ?? (yield* create));
  }).pipe(
    Effect.catch((error) =>
      logWarning("failed to open quick composer", { message: error.message }),
    ),
    Effect.withSpan("desktop.quickComposer.open"),
  );

  const toggle = Effect.suspend(() => {
    const window = live();
    if (window?.isVisible() && window.isFocused()) {
      window.hide();
      return Effect.void;
    }
    return open;
  });

  const isComposer = (senderId: number) => live()?.webContents.id === senderId;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.app.removeListener("browser-window-created", onWindowCreated);
      if (shortcutRegistered) Electron.globalShortcut.unregister(QUICK_COMPOSER_SHORTCUT);
    }),
  );

  return DesktopQuickComposer.of({
    initialize: Effect.gen(function* () {
      Electron.app.on("browser-window-created", onWindowCreated);
      shortcutRegistered = Electron.globalShortcut.register(QUICK_COMPOSER_SHORTCUT, () => {
        runFork(toggle);
      });
      if (shortcutRegistered) {
        yield* logInfo("quick composer shortcut registered", { shortcut: QUICK_COMPOSER_SHORTCUT });
      } else {
        yield* logWarning("quick composer shortcut unavailable", {
          shortcut: QUICK_COMPOSER_SHORTCUT,
        });
      }
    }).pipe(Effect.withSpan("desktop.quickComposer.initialize")),
    open,
    hide: Effect.fn("desktop.quickComposer.hide")((senderId) =>
      Effect.sync(() => {
        if (isComposer(senderId)) live()?.hide();
      }),
    ),
    submit: Effect.fn("desktop.quickComposer.submit")(function* (senderId, launch) {
      if (!isComposer(senderId)) return;
      live()?.hide();
      // The launch waits in the mailbox until the main renderer is up, even if activate made it.
      yield* desktopWindow.activate.pipe(Effect.ignoreCause);
      yield* webLinks.receiveQuickComposerLaunch(launch);
    }),
  });
});

export const layer = Layer.effect(DesktopQuickComposer, make);
