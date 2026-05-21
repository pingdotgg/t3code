import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vitest";

import type * as Electron from "electron";

vi.mock("electron", () => ({
  app: {
    on: () => undefined,
    removeListener: () => undefined,
  },
  Menu: {
    buildFromTemplate: () => ({
      popup: () => undefined,
    }),
    setApplicationMenu: () => undefined,
  },
  nativeImage: {
    createFromNamedImage: () => ({
      resize: () => ({
        isEmpty: () => true,
      }),
    }),
  },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronAppShape);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  confirm: () => Effect.succeed(false),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialogShape);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
} satisfies DesktopUpdates.DesktopUpdatesShape);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    handleBackendReady: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindowShape);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenuShape);

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(desktopUpdatesLayer),
            Layer.provideMerge(electronDialogLayer),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("shows the stable no-updates dialog from the native menu", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const dialogOptions = yield* Deferred.make<Electron.MessageBoxOptions>();
      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected createMain"),
        ensureMain: Effect.succeed({} as Electron.BrowserWindow),
        revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        handleBackendReady: Effect.void,
        dispatchMenuAction: (action) =>
          Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
        syncAppearance: Effect.void,
      } satisfies DesktopWindow.DesktopWindowShape);
      const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.succeed(Option.none()),
        confirm: () => Effect.succeed(false),
        showMessageBox: (options) =>
          Deferred.succeed(dialogOptions, options).pipe(
            Effect.as({ response: 0, checkboxChecked: false }),
          ),
        showErrorBox: () => Effect.void,
      } satisfies ElectronDialog.ElectronDialogShape);
      const updatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
        getState: Effect.die("unexpected getState"),
        emitState: Effect.void,
        disabledReason: Effect.succeed(Option.none()),
        configure: Effect.void,
        setChannel: () => Effect.die("unexpected setChannel"),
        check: () =>
          Effect.succeed({
            checked: true,
            state: {
              enabled: true,
              status: "up-to-date",
              channel: "latest",
              currentVersion: "1.2.3",
              hostArch: "arm64",
              appArch: "arm64",
              runningUnderArm64Translation: false,
              availableVersion: null,
              downloadedVersion: null,
              downloadPercent: null,
              checkedAt: "2026-05-21T12:00:00.000Z",
              message: null,
              errorContext: null,
              canRetry: false,
            },
          }),
        download: Effect.die("unexpected download"),
        install: Effect.die("unexpected install"),
      } satisfies DesktopUpdates.DesktopUpdatesShape);

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(desktopWindowLayer),
            Layer.provideMerge(updatesLayer),
            Layer.provideMerge(dialogLayer),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const helpMenu = template.find((item) => item.role === "help");
      assert.isDefined(helpMenu);
      if (!Array.isArray(helpMenu.submenu)) {
        throw new Error("Expected Help menu submenu to be an array.");
      }
      const updateItem = helpMenu.submenu.find((item) => item.label === "Check for Updates...");
      assert.isDefined(updateItem);
      const updateClick = updateItem.click;
      if (typeof updateClick !== "function") {
        throw new Error("Expected Check for Updates menu item to have a click handler.");
      }

      updateClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal((yield* Deferred.await(dialogOptions)).title, "No updates available");
    }),
  );
});
