import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopMacLoginItem from "./DesktopMacLoginItem.ts";
import { macLaunchedHidden } from "./DesktopMacLoginItem.ts";

const electron = vi.hoisted(() => {
  const state = {
    openAtLogin: false,
    wasOpenedAtLogin: false,
  };
  const setLoginItemSettings = vi.fn((settings: { readonly openAtLogin?: boolean }) => {
    state.openAtLogin = settings.openAtLogin === true;
  });
  return {
    state,
    setLoginItemSettings,
    setActivationPolicy: vi.fn(),
    dockHide: vi.fn(),
    dockShow: vi.fn(() => Promise.resolve()),
    trayCount: { current: 0 },
  };
});

vi.mock("electron", () => ({
  app: {
    getLoginItemSettings: () => ({
      openAtLogin: electron.state.openAtLogin,
      wasOpenedAtLogin: electron.state.wasOpenedAtLogin,
    }),
    setLoginItemSettings: electron.setLoginItemSettings,
    setActivationPolicy: electron.setActivationPolicy,
    dock: {
      hide: electron.dockHide,
      show: electron.dockShow,
    },
  },
  Tray: class {
    constructor() {
      electron.trayCount.current += 1;
    }
    setToolTip() {}
    setContextMenu() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
  },
  nativeImage: {
    createFromBuffer: () => ({
      resize: () => ({
        setTemplateImage() {},
        isEmpty: () => false,
      }),
    }),
  },
}));

const environmentLayer = (platform: NodeJS.Platform) =>
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform,
    displayName: "T3 Code (Alpha)",
  } as DesktopEnvironment.DesktopEnvironment["Service"]);

const provideLoginItem = (platform: NodeJS.Platform) =>
  DesktopMacLoginItem.layer.pipe(Layer.provide(environmentLayer(platform)));

describe("macOS login item", () => {
  it("treats a darwin login launch as hidden", () => {
    const argv = ["T3 Code"];
    assert.isTrue(
      macLaunchedHidden({ platform: "darwin", wasOpenedAtLogin: true, argv }),
    );
    assert.isTrue(
      macLaunchedHidden({
        platform: "darwin",
        wasOpenedAtLogin: false,
        argv: [...argv, "--t3-start-hidden"],
      }),
    );
    assert.isFalse(macLaunchedHidden({ platform: "darwin", wasOpenedAtLogin: false, argv }));
    assert.isFalse(
      macLaunchedHidden({ platform: "linux", wasOpenedAtLogin: true, argv: [...argv, "--t3-start-hidden"] }),
    );
    assert.isFalse(macLaunchedHidden({ platform: "win32", wasOpenedAtLogin: true, argv }));
  });

  it.effect("registers and unregisters the macOS login item", () => {
    electron.state.openAtLogin = false;
    electron.state.wasOpenedAtLogin = false;
    electron.setLoginItemSettings.mockClear();
    return Effect.gen(function* () {
      const loginItem = yield* DesktopMacLoginItem.DesktopMacLoginItem;
      assert.isFalse(loginItem.launchedHidden);
      assert.isFalse(yield* loginItem.getOpenAtLogin);
      yield* loginItem.setOpenAtLogin(true);
      assert.deepEqual(electron.setLoginItemSettings.mock.calls, [[{ openAtLogin: true }]]);
      assert.isTrue(yield* loginItem.getOpenAtLogin);
      yield* loginItem.setOpenAtLogin(false);
      assert.deepEqual(electron.setLoginItemSettings.mock.calls[1], [{ openAtLogin: false }]);
      assert.isFalse(yield* loginItem.getOpenAtLogin);
    }).pipe(Effect.provide(provideLoginItem("darwin")));
  });

  it.effect("hides the Dock and adds a menu bar icon when opened at login", () => {
    electron.state.wasOpenedAtLogin = true;
    electron.state.openAtLogin = true;
    electron.trayCount.current = 0;
    electron.setActivationPolicy.mockClear();
    electron.dockHide.mockClear();
    return Effect.gen(function* () {
      const loginItem = yield* DesktopMacLoginItem.DesktopMacLoginItem;
      assert.isTrue(loginItem.launchedHidden);
      assert.isTrue(yield* loginItem.deferringWindow);
      assert.deepEqual(electron.setActivationPolicy.mock.calls, [["accessory"]]);
      assert.equal(electron.dockHide.mock.calls.length, 1);

      yield* Effect.scoped(
        loginItem.installStatusItem({
          onOpen: () => undefined,
          onQuit: () => undefined,
        }),
      );
      assert.equal(electron.trayCount.current, 1);

      // The automatic activate is swallowed once; the window stays deferred.
      assert.isTrue(yield* loginItem.consumeAutomaticActivate);
      assert.isTrue(yield* loginItem.deferringWindow);
      assert.isFalse(yield* loginItem.consumeAutomaticActivate);

      yield* loginItem.presentForeground;
      assert.isFalse(yield* loginItem.deferringWindow);
      assert.deepEqual(electron.setActivationPolicy.mock.calls.at(-1), ["regular"]);
    }).pipe(Effect.provide(provideLoginItem("darwin")));
  });

  it.effect("does not touch login items on other platforms", () => {
    electron.state.wasOpenedAtLogin = true;
    electron.setLoginItemSettings.mockClear();
    electron.setActivationPolicy.mockClear();
    return Effect.gen(function* () {
      const loginItem = yield* DesktopMacLoginItem.DesktopMacLoginItem;
      assert.isFalse(loginItem.launchedHidden);
      yield* loginItem.setOpenAtLogin(true);
      assert.deepEqual(electron.setLoginItemSettings.mock.calls, []);
      assert.isFalse(yield* loginItem.getOpenAtLogin);
      assert.equal(electron.setActivationPolicy.mock.calls.length, 0);
    }).pipe(Effect.provide(provideLoginItem("linux")));
  });
});
