import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

const testLayer = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcessPlatform, platform)));

const TestLayer = testLayer("linux");

function makeBrowserWindow(input: { readonly id: number; readonly destroyed: boolean }) {
  return {
    id: input.id,
    isDestroyed: vi.fn(() => input.destroyed),
  } as unknown as Electron.BrowserWindow;
}

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

  it.effect("preserves schema-safe creation context and the Electron cause", () =>
    Effect.gen(function* () {
      const cause = new Error("native BrowserWindow construction failed");
      browserWindowMock.mockImplementationOnce(function BrowserWindowFailure() {
        throw cause;
      });
      const options = {
        title: "T3 Code",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        icon: {} as Electron.NativeImage,
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          spellcheck: true,
        },
      } satisfies Electron.BrowserWindowConstructorOptions;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const error = yield* electronWindow.create(options).pipe(Effect.flip);

      assert.instanceOf(error, ElectronWindow.ElectronWindowCreateError);
      assert.deepEqual(error.options, {
        title: "T3 Code",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          backgroundThrottling: null,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
        },
      });
      assert.isFalse("icon" in error.options);
      assert.isFalse("spellcheck" in error.options.webPreferences);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to create Electron BrowserWindow "T3 Code" (1100x780).');
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(browserWindowMock.mock.calls, [[options]]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("skips windows destroyed before appearance sync runs", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ id: 1, destroyed: false });
      const destroyedWindow = makeBrowserWindow({ id: 2, destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves window enumeration failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("window enumeration failed");
      getAllWindowsMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.currentMainOrFirst);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "list-windows");
        assert.equal(error.platform, "linux");
        assert.isNull(error.windowId);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves reveal failures with the target window", () =>
    Effect.gen(function* () {
      const cause = new Error("window restore failed");
      const window = {
        id: 41,
        isDestroyed: vi.fn(() => false),
        isMinimized: vi.fn(() => true),
        restore: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.reveal(window));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "reveal-window");
        assert.equal(error.windowId, 41);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uses native Windows activation without querying the foreground window", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      appFocusMock.mockImplementation(() => operations.push("app-focus"));
      activateWindowsForegroundMock.mockImplementation(async () => {
        operations.push("native-activation");
      });
      const window = {
        ...makeWindowsRevealWindow(),
        show: vi.fn(() => operations.push("show")),
        moveTop: vi.fn(() => operations.push("move-top")),
        focus: vi.fn(() => operations.push("focus")),
      } as unknown as Electron.BrowserWindow;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window);

      yield* electronWindow.reveal(window);

      assert.deepEqual(operations, ["app-focus", "show", "move-top", "focus", "native-activation"]);
      assert.lengthOf(loadWindowsForegroundApiMock.mock.calls, 0);
      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("focuses the exact T3 window before activating from a shell-hosted app", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      shellHostedForegroundMock.mockResolvedValue(true);
      windowsForegroundFocusMock.mockImplementation(async () => {
        operations.push("native-focus");
        return true;
      });
      activateWindowsForegroundMock.mockImplementation(async () => {
        operations.push("native-activation");
      });
      const window = {
        ...makeWindowsRevealWindow(),
        show: vi.fn(() => operations.push("show")),
        moveTop: vi.fn(() => operations.push("move-top")),
        focus: vi.fn(() => operations.push("focus")),
      } as unknown as Electron.BrowserWindow;
      appFocusMock.mockImplementation(() => operations.push("app-focus"));
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window);

      yield* electronWindow.reveal(window);

      assert.deepEqual(operations, [
        "app-focus",
        "show",
        "move-top",
        "focus",
        "native-focus",
        "native-activation",
      ]);
      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 1);
      assert.deepEqual(windowsForegroundFocusMock.mock.calls, [
        [
          {
            windowId: 41,
            processId: process.pid,
            title: "T3 Code (Dev)",
            bounds: { x: 100, y: 50, width: 1_200, height: 800 },
            contentBounds: { x: 108, y: 50, width: 1_184, height: 792 },
          },
        ],
      ]);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("prepares the exact T3 window before a capture overlay", () =>
    Effect.gen(function* () {
      windowsForegroundPrepareMock.mockResolvedValue(true);
      const window = makeWindowsRevealWindow();
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const prepared = yield* electronWindow.prepareReveal(
        window as unknown as Electron.BrowserWindow,
      );

      assert.isTrue(prepared);
      assert.deepEqual(windowsForegroundPrepareMock.mock.calls, [
        [
          {
            windowId: 41,
            processId: process.pid,
            title: "T3 Code (Dev)",
            bounds: { x: 100, y: 50, width: 1_200, height: 800 },
            contentBounds: { x: 108, y: 50, width: 1_184, height: 792 },
          },
        ],
      ]);
      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 0);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect.each([4, 8])(
    "skips the focus worker only when the foreground matches the %i-byte HWND",
    (handleBytes) =>
      Effect.gen(function* () {
        const window = makeWindowsRevealWindow();
        activateWindowsForegroundMock.mockRejectedValueOnce(
          new Error("Windows initially refused foreground activation"),
        );
        const hwnd = handleBytes === 4 ? 0xf123_4567n : 0x1_f123_4567n;
        const handle = Buffer.alloc(handleBytes);
        if (handleBytes === 4) handle.writeUInt32LE(Number(hwnd));
        else handle.writeBigUInt64LE(hwnd);
        window.getNativeWindowHandle.mockReturnValue(handle);
        foregroundWindowMock.mockReturnValue(hwnd);
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);
        window.getTitle.mockClear();

        yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

        assert.lengthOf(foregroundWindowMock.mock.calls, 1);
        assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
        assert.lengthOf(window.getTitle.mock.calls, 0);
        assert.lengthOf(activateWindowsForegroundMock.mock.calls, 2);
      }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect.each([42n, 0n])(
    "focuses through the worker when the foreground HWND is %s instead of the target",
    (foreground) =>
      Effect.gen(function* () {
        const window = makeWindowsRevealWindow();
        activateWindowsForegroundMock.mockRejectedValueOnce(
          new Error("Windows initially refused foreground activation"),
        );
        foregroundWindowMock.mockReturnValue(foreground);
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);

        yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

        assert.lengthOf(windowsForegroundFocusMock.mock.calls, 1);
        assert.lengthOf(activateWindowsForegroundMock.mock.calls, 2);
      }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("continues native focus when the foreground query fails", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      loadWindowsForegroundApiMock.mockRejectedValue(new Error("Foreground query unavailable"));
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 1);
      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 2);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("does not fail reveal when native focus rejects", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      windowsForegroundFocusMock.mockRejectedValue(new Error("Focus rejected"));
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 1);
      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 2);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("fails reveal when Windows refuses foreground activation", () =>
    Effect.gen(function* () {
      const cause = new Error("Windows refused foreground activation");
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValue(cause);
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);

      const exit = yield* Effect.exit(
        electronWindow.reveal(window as unknown as Electron.BrowserWindow),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "reveal-window");
        assert.strictEqual(error.cause, cause);
      }
      assert.deepEqual(activateWindowsForegroundMock.mock.calls, [
        [window.getNativeWindowHandle.mock.results[0]?.value],
        [window.getNativeWindowHandle.mock.results[1]?.value],
      ]);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

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
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("preserves message delivery failures with window and channel context", () =>
    Effect.gen(function* () {
      const cause = new Error("renderer send failed");
      const window = {
        id: 42,
        isDestroyed: vi.fn(() => false),
        webContents: {
          send: vi.fn(() => {
            throw cause;
          }),
        },
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.sendAll("desktop:update", { ready: true }));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "send-window-message");
        assert.equal(error.windowId, 42);
        assert.equal(error.channel, "desktop:update");
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("an ordinary reveal on Windows does not touch the Win32 foreground helpers", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 0);
      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
      assert.lengthOf(shellHostedForegroundMock.mock.calls, 0);
      assert.lengthOf(startWindowsForegroundFocusThreadMock.mock.calls, 0);
      assert.lengthOf(window.focus.mock.calls, 1);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("a capture reveal on Windows uses the Win32 path only once", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);
      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);
      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 1);
      assert.lengthOf(window.focus.mock.calls, 2);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("starts the Windows focus worker lazily and closes it with the layer", () =>
    Effect.gen(function* () {
      yield* ElectronWindow.ElectronWindow.pipe(Effect.provide(testLayer("win32")));
      assert.lengthOf(startWindowsForegroundFocusThreadMock.mock.calls, 0);
      assert.lengthOf(windowsForegroundCloseMock.mock.calls, 0);

      yield* Effect.gen(function* () {
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        const window = makeWindowsRevealWindow() as unknown as Electron.BrowserWindow;
        yield* electronWindow.prepareReveal(window);
        yield* electronWindow.prepareReveal(window);
        assert.lengthOf(startWindowsForegroundFocusThreadMock.mock.calls, 1);
        assert.lengthOf(windowsForegroundCloseMock.mock.calls, 0);
      }).pipe(Effect.provide(testLayer("win32")));
      assert.lengthOf(windowsForegroundCloseMock.mock.calls, 1);
    }),
  );
});
