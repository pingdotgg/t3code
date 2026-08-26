import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { constructedOptions, showMock, isSupportedMock, getFocusedWindowMock } = vi.hoisted(() => ({
  constructedOptions: vi.fn(),
  showMock: vi.fn(),
  isSupportedMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
}));

vi.mock("electron", () => {
  class NotificationMock {
    static isSupported = isSupportedMock;
    show = showMock;
    constructor(options: unknown) {
      constructedOptions(options);
    }
  }
  return {
    Notification: NotificationMock,
    BrowserWindow: {
      getFocusedWindow: getFocusedWindowMock,
    },
  };
});

import * as ElectronNotification from "./ElectronNotification.ts";

const layerFor = (platform: NodeJS.Platform) =>
  ElectronNotification.layer.pipe(Layer.provide(Layer.succeed(HostProcessPlatform, platform)));

describe("ElectronNotification", () => {
  beforeEach(() => {
    constructedOptions.mockReset();
    showMock.mockReset();
    isSupportedMock.mockReset().mockReturnValue(true);
    getFocusedWindowMock.mockReset().mockReturnValue(null);
  });

  it.effect("shows a silent toast on unfocused win32", () =>
    Effect.gen(function* () {
      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, true);
      assert.deepEqual(constructedOptions.mock.calls, [
        [{ title: "Agent finished", body: "Fix failing CI", silent: true }],
      ]);
      assert.equal(showMock.mock.calls.length, 1);
    }).pipe(Effect.provide(layerFor("win32"))),
  );

  it.effect("suppresses while a window is focused", () =>
    Effect.gen(function* () {
      getFocusedWindowMock.mockReturnValue({});

      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, false);
      assert.equal(constructedOptions.mock.calls.length, 0);
    }).pipe(Effect.provide(layerFor("win32"))),
  );

  it.effect("suppresses on darwin", () =>
    Effect.gen(function* () {
      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, false);
      assert.equal(constructedOptions.mock.calls.length, 0);
    }).pipe(Effect.provide(layerFor("darwin"))),
  );

  it.effect("suppresses on linux", () =>
    Effect.gen(function* () {
      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, false);
      assert.equal(constructedOptions.mock.calls.length, 0);
    }).pipe(Effect.provide(layerFor("linux"))),
  );

  it.effect("suppresses when notifications are unsupported", () =>
    Effect.gen(function* () {
      isSupportedMock.mockReturnValue(false);

      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, false);
      assert.equal(constructedOptions.mock.calls.length, 0);
    }).pipe(Effect.provide(layerFor("win32"))),
  );

  it.effect("returns false when show throws", () =>
    Effect.gen(function* () {
      showMock.mockImplementation(() => {
        throw new Error("toast failed");
      });

      const notification = yield* ElectronNotification.ElectronNotification;
      const result = yield* notification.showAgentTurnCompleted({ threadTitle: "Fix failing CI" });

      assert.equal(result, false);
    }).pipe(Effect.provide(layerFor("win32"))),
  );
});

describe("shouldShowAgentTurnNotification", () => {
  it("allows only unfocused, supported win32", () => {
    const unfocusedSupported = { anyWindowFocused: false, supported: true };
    assert.equal(
      ElectronNotification.shouldShowAgentTurnNotification({
        ...unfocusedSupported,
        platform: "win32",
      }),
      true,
    );
    assert.equal(
      ElectronNotification.shouldShowAgentTurnNotification({
        ...unfocusedSupported,
        platform: "darwin",
      }),
      false,
    );
    assert.equal(
      ElectronNotification.shouldShowAgentTurnNotification({
        ...unfocusedSupported,
        platform: "linux",
      }),
      false,
    );
    assert.equal(
      ElectronNotification.shouldShowAgentTurnNotification({
        platform: "win32",
        anyWindowFocused: true,
        supported: true,
      }),
      false,
    );
    assert.equal(
      ElectronNotification.shouldShowAgentTurnNotification({
        platform: "win32",
        anyWindowFocused: false,
        supported: false,
      }),
      false,
    );
  });
});
