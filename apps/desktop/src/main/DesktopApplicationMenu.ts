import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopRun from "./DesktopRun.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

type DesktopApplicationMenuRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopRun.DesktopRun
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronMenu.ElectronMenu;

export interface DesktopApplicationMenuShape {
  readonly configure: Effect.Effect<void>;
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  DesktopApplicationMenuShape
>()("t3/desktop/ApplicationMenu") {}

const dispatchMenuAction = (
  action: string,
): Effect.Effect<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> =>
  Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.dispatchMenuAction(action);
  });

const checkForUpdatesFromMenu: Effect.Effect<
  void,
  never,
  DesktopUpdates.DesktopUpdates | ElectronDialog.ElectronDialog
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
});

const handleCheckForUpdatesMenuClick: Effect.Effect<
  void,
  DesktopWindow.DesktopWindowError,
  | DesktopRun.DesktopRun
  | DesktopUpdates.DesktopUpdates
  | ElectronDialog.ElectronDialog
  | DesktopWindow.DesktopWindow
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const run = yield* DesktopRun.DesktopRun;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* run.logInfo("manual update check requested, but updates are disabled", {
      component: "desktop-updater",
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
});

const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const run = yield* DesktopRun.DesktopRun;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();

  const runMenuEffect = <E, R>(action: string, effect: Effect.Effect<void, E, R>) => {
    void Effect.runPromiseWith(context as unknown as Context.Context<R>)(
      effect.pipe(
        Effect.catchCause((cause) =>
          run.logError("desktop menu action failed", {
            action,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  };

  const checkForUpdatesClick = () => {
    runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
  };

  const settingsClick = () => {
    runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
  };

  const configure = Effect.gen(function* () {
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          { role: environment.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  });

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
