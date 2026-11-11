import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState, DesktopUpdateStatus } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: vi.fn(() => []) },
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

const layerElectronApp = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  preferredSystemLanguages: Effect.succeed(["en-US"]),
  whenReady: Effect.void,
  requestSingleInstanceLock: Effect.succeed(true),
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const layerElectronDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeedNone,
  pickFiles: () => Effect.succeed([]),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"]);

const layerRecordingDialog = (shown: Deferred.Deferred<Electron.MessageBoxOptions>) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeedNone,
    pickFiles: () => Effect.succeed([]),
    showMessageBox: (options) =>
      Deferred.succeed(shown, options).pipe(Effect.as({ response: 0, checkboxChecked: false })),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const menuUpdateState = (
  status: DesktopUpdateStatus,
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState => ({
  enabled: true,
  status,
  channel: "latest",
  currentVersion: "1.2.3",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  ...overrides,
});

const desktopUpdatesService = (
  overrides: Partial<DesktopUpdates.DesktopUpdates["Service"]> = {},
): DesktopUpdates.DesktopUpdates["Service"] => ({
  getState: Effect.die("unexpected getState"),
  isActionActive: Effect.succeed(false),
  isInstallActive: Effect.succeed(false),
  subscribe: Effect.succeed({
    latest: menuUpdateState("idle"),
    changes: Stream.empty,
  }),
  emitState: Effect.void,
  disabledReason: Effect.succeedNone,
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
  installPrepared: () => Effect.die("unexpected installPrepared"),
  ...overrides,
});

const layerDesktopUpdates = Layer.succeed(DesktopUpdates.DesktopUpdates, desktopUpdatesService());

const layerDesktopUpdatesWith = (overrides: Partial<DesktopUpdates.DesktopUpdates["Service"]>) =>
  Layer.succeed(DesktopUpdates.DesktopUpdates, desktopUpdatesService(overrides));

const layerDesktopWindow = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    runMainContentsCommand: (command) =>
      Deferred.succeed(selectedAction, `main-${command}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const layerElectronMenu = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeedNone,
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  environment: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  updates: Layer.Layer<DesktopUpdates.DesktopUpdates> = layerDesktopUpdates,
  dialog: Layer.Layer<ElectronDialog.ElectronDialog> = layerElectronDialog,
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(layerElectronMenu(applicationMenuTemplate)),
        Layer.provideMerge(layerDesktopWindow(selectedAction)),
        Layer.provideMerge(updates),
        Layer.provideMerge(dialog),
        Layer.provideMerge(layerElectronApp),
        Layer.provideMerge(
          DesktopEnvironment.layer({ ...environmentInput, ...environment }).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

const clickCheckForUpdates = (template: readonly Electron.MenuItemConstructorOptions[]) => {
  const helpMenu = template.find((item) => item.role === "help");
  if (!Array.isArray(helpMenu?.submenu)) {
    throw new Error("Expected Help menu submenu to be an array.");
  }
  const checkForUpdates = helpMenu.submenu.find((item) => item.label === "Check for Updates...");
  if (typeof checkForUpdates?.click !== "function") {
    throw new Error("Expected Check for Updates menu item to have a click handler.");
  }
  checkForUpdates.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
};

describe("DesktopApplicationMenu", () => {
  it.effect("leaves the accelerator to Chromium instead of injecting a paste", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      if (!Array.isArray(editMenu?.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      if (typeof pasteAsTextItem?.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {
          triggeredByAccelerator: true,
        } as unknown as KeyboardEvent,
      );
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  it.effect("registers macOS command-plus once and routes it through main-window zoom", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) =>
          ["zoom", "reload", "devtools"].some((role) => item.role?.toLowerCase().includes(role)),
        ),
      );

      const shiftedEqual = viewMenu.submenu.filter(
        (item) => item.accelerator === "CmdOrCtrl+Shift+=",
      );
      assert.lengthOf(shiftedEqual, 1);
      assert.lengthOf(
        viewMenu.submenu.filter((item) => item.accelerator === "CmdOrCtrl+numadd"),
        1,
      );
      const zoomIn = shiftedEqual[0];
      assert.isDefined(zoomIn);
      assert.isFalse(zoomIn.visible);
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  it.effect("never binds Cmd/Ctrl+W to closing the window", () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          platform,
        });

        const items: Electron.MenuItemConstructorOptions[] = [];
        const collect = (template: readonly Electron.MenuItemConstructorOptions[]) => {
          for (const item of template) {
            items.push(item);
            if (Array.isArray(item.submenu)) collect(item.submenu);
          }
        };
        collect(yield* Deferred.await(applicationMenuTemplate));

        assert.isUndefined(
          items.find((item) => item.role === "close"),
          platform,
        );
        // Electron's default windowMenu submenu includes a close role.
        assert.isUndefined(
          items.find((item) => item.role === "windowMenu" && item.submenu === undefined),
          platform,
        );
        const closeTools = items.find((item) => item.accelerator === "CmdOrCtrl+W");
        assert.equal(closeTools?.label, "Close Developer Tools", platform);
        assert.isFunction(closeTools?.click);
        const appContents = {
          isDestroyed: () => false,
          isDevToolsFocused: () => false,
          closeDevTools: vi.fn(),
        };
        const inspectedContents = {
          ...appContents,
          isDevToolsFocused: () => true,
          closeDevTools: vi.fn(),
        };
        using allContents = vi
          .spyOn(Electron.webContents, "getAllWebContents")
          .mockReturnValue([
            appContents as unknown as Electron.WebContents,
            inspectedContents as unknown as Electron.WebContents,
          ]);
        closeTools?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
        assert.equal(inspectedContents.closeDevTools.mock.calls.length, 1);
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);

        allContents.mockReturnValue([appContents as unknown as Electron.WebContents]);
        closeTools?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);
      }
    }),
  );

  it.effect("reloads the main window even while a browser page has focus", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      if (!Array.isArray(viewMenu?.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }
      const reload = viewMenu.submenu.find((item) => item.label === "Reload");
      assert.equal(reload?.accelerator, "CmdOrCtrl+R");
      if (typeof reload?.click !== "function") {
        throw new Error("Expected Reload menu item to have a click handler.");
      }

      reload.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "main-reload");
    }),
  );

  it.effect("explains when updates are disabled without checking", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
      let checked = false;

      yield* configureMenu(
        selectedAction,
        applicationMenuTemplate,
        {},
        layerDesktopUpdatesWith({
          disabledReason: Effect.succeed(Option.some("This build has no update feed.")),
          check: () =>
            Effect.sync(() => {
              checked = true;
            }).pipe(Effect.andThen(Effect.die("unexpected check"))),
        }),
        layerRecordingDialog(shown),
      );

      clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
      const dialog = yield* Deferred.await(shown);
      assert.equal(dialog.title, "Updates unavailable");
      assert.equal(dialog.detail, "This build has no update feed.");
      assert.isFalse(checked);
    }),
  );

  it.effect("shows the settled up-to-date and error dialogs from a manual check", () =>
    Effect.gen(function* () {
      const cases = [
        {
          state: menuUpdateState("up-to-date"),
          title: "You're up to date!",
          message: "T3 Code 1.2.3 is currently the newest version available.",
          detail: undefined,
        },
        {
          state: menuUpdateState("error", { message: "feed down" }),
          title: "Update check failed",
          message: "Could not check for updates.",
          detail: "feed down",
        },
        {
          state: menuUpdateState("error"),
          title: "Update check failed",
          message: "Could not check for updates.",
          detail: "An unknown error occurred. Please try again later.",
        },
      ];

      for (const expected of cases) {
        const selectedAction = yield* Deferred.make<string>();
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
        yield* configureMenu(
          selectedAction,
          applicationMenuTemplate,
          {},
          layerDesktopUpdatesWith({
            check: () => Effect.succeed({ checked: true, state: expected.state }),
            subscribe: Effect.die("unexpected subscribe"),
          }),
          layerRecordingDialog(shown),
        );

        clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
        const dialog = yield* Deferred.await(shown);
        assert.equal(dialog.title, expected.title);
        assert.equal(dialog.message, expected.message);
        assert.equal(dialog.detail, expected.detail);
      }
    }),
  );

  it.effect("stays quiet when a manual check finds or already has an update", () =>
    Effect.gen(function* () {
      for (const status of ["available", "downloaded"] as const) {
        const selectedAction = yield* Deferred.make<string>();
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
        yield* configureMenu(
          selectedAction,
          applicationMenuTemplate,
          {},
          layerDesktopUpdatesWith({
            check: () => Effect.succeed({ checked: true, state: menuUpdateState(status) }),
            subscribe: Effect.die("unexpected subscribe"),
          }),
          layerRecordingDialog(shown),
        );

        clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(shown));
      }
    }),
  );

  it.effect("waits until a manual check leaves checking before choosing a dialog", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
      const settled = yield* Queue.unbounded<DesktopUpdateState>();
      yield* configureMenu(
        selectedAction,
        applicationMenuTemplate,
        {},
        layerDesktopUpdatesWith({
          check: () => Effect.succeed({ checked: true, state: menuUpdateState("checking") }),
          subscribe: Effect.succeed({
            latest: menuUpdateState("checking"),
            changes: Stream.fromQueue(settled),
          }),
        }),
        layerRecordingDialog(shown),
      );

      clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
      assert.isFalse(yield* Deferred.isDone(shown));
      yield* Queue.offer(settled, menuUpdateState("error", { message: "feed down" }));
      const dialog = yield* Deferred.await(shown);
      assert.equal(dialog.title, "Update check failed");
      assert.equal(dialog.detail, "feed down");
    }),
  );

  it.effect("uses the subscribed snapshot when the check result is still checking", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
      yield* configureMenu(
        selectedAction,
        applicationMenuTemplate,
        {},
        layerDesktopUpdatesWith({
          check: () => Effect.succeed({ checked: true, state: menuUpdateState("checking") }),
          subscribe: Effect.succeed({
            latest: menuUpdateState("up-to-date"),
            changes: Stream.never,
          }),
        }),
        layerRecordingDialog(shown),
      );

      clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
      const dialog = yield* Deferred.await(shown);
      assert.equal(dialog.title, "You're up to date!");
      assert.equal(dialog.message, "T3 Code 1.2.3 is currently the newest version available.");
    }),
  );

  it.effect("does not invent a dialog when a manual check stays checking", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shown = yield* Deferred.make<Electron.MessageBoxOptions>();
      const subscribed = yield* Deferred.make<void>();
      const settled = yield* Queue.unbounded<DesktopUpdateState>();
      yield* configureMenu(
        selectedAction,
        applicationMenuTemplate,
        {},
        layerDesktopUpdatesWith({
          check: () => Effect.succeed({ checked: true, state: menuUpdateState("checking") }),
          subscribe: Deferred.succeed(subscribed, undefined).pipe(
            Effect.as({
              latest: menuUpdateState("checking"),
              changes: Stream.fromQueue(settled),
            }),
          ),
        }),
        layerRecordingDialog(shown),
      );

      clickCheckForUpdates(yield* Deferred.await(applicationMenuTemplate));
      yield* Deferred.await(subscribed);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      yield* Queue.offer(settled, menuUpdateState("up-to-date"));
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(shown));
    }),
  );
});
