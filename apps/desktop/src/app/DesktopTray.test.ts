import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const makeEnvironmentLayer = (platform: "win32" | "darwin" | "linux") =>
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/alice",
    platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
    displayName: "T3 Code",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.some("C:/path/to/icon.ico"),
    icns: Option.none(),
    png: Option.some("C:/path/to/icon.png"),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const makeElectronTrayLayer = (
  createdOptions: Deferred.Deferred<ElectronTray.ElectronTrayCreateOptions>,
) =>
  Layer.succeed(ElectronTray.ElectronTray, {
    create: (options) =>
      Deferred.succeed(createdOptions, options).pipe(Effect.andThen(Effect.succeed({} as any))),
    destroy: Effect.void,
  } satisfies ElectronTray.ElectronTray["Service"]);

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  isDefaultProtocolClient: () => Effect.succeed(false),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
  createMain: Effect.die("unexpected createMain"),
  ensureMain: Effect.die("unexpected ensureMain"),
  revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
  activate: Effect.void,
  createMainIfBackendReady: Effect.void,
  showConnectingSplash: Effect.void,
  handleBackendReady: () => Effect.void,
  handleBackendNotReady: Effect.void,
  flushMainWindowBounds: Effect.void,
  dispatchMenuAction: () => Effect.void,
  zoomMain: () => Effect.void,
  syncAppearance: Effect.void,
} satisfies DesktopWindow.DesktopWindow["Service"]);

describe("DesktopTray", () => {
  it.effect("configures tray icon and menu on win32", () =>
    Effect.gen(function* () {
      const createdOptions = yield* Deferred.make<ElectronTray.ElectronTrayCreateOptions>();
      const testLayer = DesktopTray.layer.pipe(
        Layer.provideMerge(makeElectronTrayLayer(createdOptions)),
        Layer.provideMerge(desktopAssetsLayer),
        Layer.provideMerge(makeEnvironmentLayer("win32")),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          assert.isFalse(yield* tray.isAvailable);

          yield* tray.configure;

          const options = yield* Deferred.await(createdOptions);
          assert.equal(options.iconPath, "C:/path/to/icon.ico");
          assert.equal(options.tooltip, "T3 Code");
          assert.isDefined(options.menuItems);
          const menuItems = options.menuItems ?? [];
          assert.equal(menuItems.length, 3);
          assert.equal(menuItems[0]?.label, "Open T3 Code");
          assert.equal(menuItems[2]?.label, "Quit T3 Code");
          assert.isTrue(yield* tray.isAvailable);
        }),
      ).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("skips configuring tray on darwin", () =>
    Effect.gen(function* () {
      const createdOptions = yield* Deferred.make<ElectronTray.ElectronTrayCreateOptions>();
      const testLayer = DesktopTray.layer.pipe(
        Layer.provideMerge(makeElectronTrayLayer(createdOptions)),
        Layer.provideMerge(desktopAssetsLayer),
        Layer.provideMerge(makeEnvironmentLayer("darwin")),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure;

          assert.isFalse(yield* Deferred.isDone(createdOptions));
          assert.isFalse(yield* tray.isAvailable);
        }),
      ).pipe(Effect.provide(testLayer));
    }),
  );
});
