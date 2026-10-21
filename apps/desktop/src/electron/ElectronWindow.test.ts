import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const {
  activateWindowsForegroundMock,
  appFocusMock,
  browserWindowMock,
  foregroundWindowMock,
  getAllWindowsMock,
  getFocusedWindowMock,
  loadWindowsForegroundApiMock,
  shellHostedForegroundMock,
  startWindowsForegroundFocusThreadMock,
  windowsForegroundFocusMock,
  windowsForegroundPrepareMock,
  windowsForegroundCloseMock,
} = vi.hoisted(() => ({
  activateWindowsForegroundMock: vi.fn(),
  appFocusMock: vi.fn(),
  browserWindowMock: vi.fn(function BrowserWindowMock() {}),
  foregroundWindowMock: vi.fn<() => bigint>(),
  getAllWindowsMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
  loadWindowsForegroundApiMock: vi.fn<() => Promise<{ getForegroundWindow: () => bigint }>>(),
  shellHostedForegroundMock: vi.fn(),
  startWindowsForegroundFocusThreadMock: vi.fn(),
  windowsForegroundFocusMock: vi.fn(),
  windowsForegroundPrepareMock: vi.fn(),
  windowsForegroundCloseMock: vi.fn(),
}));

vi.mock("./WindowsForeground.ts", () => ({
  activateWindowsForeground: activateWindowsForegroundMock,
  isWindowsShellHostedForeground: shellHostedForegroundMock,
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

vi.mock("./WindowsForegroundFocusThread.ts", () => ({
  startWindowsForegroundFocusThread: startWindowsForegroundFocusThreadMock,
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "./ElectronWindow.ts";

const layerTestFor = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform)));

const layerTest = layerTestFor("linux");

function makeWindowsRevealWindow() {
  return {
    id: 41,
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    getTitle: vi.fn(() => "T3 Code (Dev)"),
    getBounds: vi.fn(() => ({ x: 100, y: 50, width: 1_200, height: 800 })),
    getContentBounds: vi.fn(() => ({ x: 108, y: 50, width: 1_184, height: 792 })),
    getNativeWindowHandle: vi.fn(() => Buffer.from([41, 0, 0, 0])),
    restore: vi.fn(),
  };
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    activateWindowsForegroundMock.mockReset().mockResolvedValue(undefined);
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    foregroundWindowMock.mockReset().mockReturnValue(0n);
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
    loadWindowsForegroundApiMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ getForegroundWindow: foregroundWindowMock }));
    shellHostedForegroundMock.mockReset().mockResolvedValue(false);
    startWindowsForegroundFocusThreadMock.mockReset().mockReturnValue({
      prepare: windowsForegroundPrepareMock,
      focus: windowsForegroundFocusMock,
      close: windowsForegroundCloseMock,
    });
    windowsForegroundFocusMock.mockReset().mockResolvedValue(false);
    windowsForegroundPrepareMock.mockReset().mockResolvedValue(false);
    windowsForegroundCloseMock.mockReset();
  });

  it.effect("cancels native focus when destroyed during the foreground query", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      const queryStarted = Promise.withResolvers<void>();
      const foreground = Promise.withResolvers<{ getForegroundWindow: () => bigint }>();
      loadWindowsForegroundApiMock.mockImplementation(() => {
        queryStarted.resolve();
        return foreground.promise;
      });
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);
      window.getTitle.mockClear();

      const revealFiber = yield* electronWindow
        .reveal(window as unknown as Electron.BrowserWindow)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => queryStarted.promise);
      window.isDestroyed.mockReturnValue(true);
      foreground.resolve({ getForegroundWindow: foregroundWindowMock });
      yield* Fiber.join(revealFiber);

      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
      assert.lengthOf(window.getNativeWindowHandle.mock.calls, 1);
      assert.lengthOf(window.getTitle.mock.calls, 0);
    }).pipe(Effect.provide(layerTestFor("win32"))),
  );

  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      const laterWindow = {
        id: 44,
        destroy: vi.fn(),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window, laterWindow]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
      assert.equal(vi.mocked(laterWindow.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );
});
