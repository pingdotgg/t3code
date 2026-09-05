import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const {
  activeWindowMock,
  activateWindowsForegroundMock,
  appFocusMock,
  browserWindowMock,
  getAllWindowsMock,
  getFocusedWindowMock,
  nativeAppByPidMock,
  nativeAppListMock,
  shellHostedForegroundMock,
  windowsForegroundFocusMock,
  windowsForegroundPrepareMock,
  windowsForegroundCloseMock,
} = vi.hoisted(() => ({
  activeWindowMock: vi.fn(),
  activateWindowsForegroundMock: vi.fn(),
  appFocusMock: vi.fn(),
  browserWindowMock: vi.fn(function BrowserWindowMock() {}),
  getAllWindowsMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
  nativeAppByPidMock: vi.fn(),
  nativeAppListMock: vi.fn(),
  shellHostedForegroundMock: vi.fn(),
  windowsForegroundFocusMock: vi.fn(),
  windowsForegroundPrepareMock: vi.fn(),
  windowsForegroundCloseMock: vi.fn(),
}));

vi.mock("get-windows", () => ({ activeWindow: activeWindowMock }));

vi.mock("./WindowsForeground.ts", () => ({
  activateWindowsForeground: activateWindowsForegroundMock,
  isWindowsShellHostedForeground: shellHostedForegroundMock,
}));

vi.mock("./WindowsForegroundFocusThread.ts", () => ({
  startWindowsForegroundFocusThread: () => ({
    prepare: windowsForegroundPrepareMock,
    focus: windowsForegroundFocusMock,
    close: windowsForegroundCloseMock,
  }),
}));

vi.mock("@crowecawcaw/xa11y", () => ({
  App: {
    byPid: nativeAppByPidMock,
    list: nativeAppListMock,
  },
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
    activeWindowMock.mockReset().mockResolvedValue(undefined);
    activateWindowsForegroundMock.mockReset().mockResolvedValue(undefined);
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
    nativeAppByPidMock.mockReset();
    nativeAppListMock.mockReset().mockResolvedValue([]);
    shellHostedForegroundMock.mockReset().mockResolvedValue(false);
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

  it.effect("uses native Windows activation without starting the accessibility fallback", () =>
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

      yield* electronWindow.reveal(window);

      assert.deepEqual(operations, ["app-focus", "show", "move-top", "focus", "native-activation"]);
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(nativeAppListMock.mock.calls, 0);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("falls back to accessibility before retrying native Windows activation", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      const nativeFocusStarted = Promise.withResolvers<void>();
      const allowNativeFocus = Promise.withResolvers<void>();
      const listingStarted = Promise.withResolvers<void>();
      const readNativeBounds = vi.fn(() => ({ x: 100, y: 50, width: 1_200, height: 800 }));
      const listedApps = Promise.withResolvers<
        Array<{
          pid: number;
          asElement: () => { name: string; focus: () => Promise<void> };
        }>
      >();
      appFocusMock.mockImplementation(() => operations.push("app-focus"));
      activateWindowsForegroundMock
        .mockRejectedValueOnce(new Error("Windows initially refused foreground activation"))
        .mockImplementationOnce(async () => {
          operations.push("native-activation");
        });
      nativeAppListMock.mockImplementation(() => {
        listingStarted.resolve();
        return listedApps.promise;
      });
      activeWindowMock.mockResolvedValue({ id: 99, owner: { processId: process.pid + 1 } });
      const apps = [
        {
          pid: process.pid,
          asElement: () => ({
            name: "T3 Code (Dev)",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focus: async () => {
              operations.push("wrong-native-focus");
            },
          }),
        },
        {
          pid: process.pid,
          asElement: () => ({
            name: "T3 Code (Dev)",
            get bounds() {
              return readNativeBounds();
            },
            focus: async () => {
              operations.push("native-focus");
              nativeFocusStarted.resolve();
              await allowNativeFocus.promise;
            },
          }),
        },
      ];
      nativeAppByPidMock.mockResolvedValue({
        asElement: () => ({
          name: "fallback",
          focus: async () => {
            operations.push("fallback-native-focus");
          },
        }),
      });
      const window = {
        ...makeWindowsRevealWindow(),
        isFocused: vi.fn(() => true),
        show: vi.fn(() => operations.push("show")),
        moveTop: vi.fn(() => operations.push("move-top")),
        focus: vi.fn(() => operations.push("focus")),
      } as unknown as Electron.BrowserWindow;

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const revealFiber = yield* electronWindow.reveal(window).pipe(
        Effect.andThen(
          Effect.sync(() => {
            operations.push("revealed");
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => listingStarted.promise);

      assert.deepEqual(operations, ["app-focus", "show", "move-top", "focus"]);
      assert.equal(vi.mocked(window.restore).mock.calls.length, 0);
      assert.deepEqual(appFocusMock.mock.calls, [[]]);
      assert.deepEqual(nativeAppListMock.mock.calls, [[]]);

      listedApps.resolve(apps);
      yield* Effect.promise(() => nativeFocusStarted.promise);
      assert.deepEqual(operations, ["app-focus", "show", "move-top", "focus", "native-focus"]);
      allowNativeFocus.resolve();
      yield* Fiber.join(revealFiber);
      assert.deepEqual(operations, [
        "app-focus",
        "show",
        "move-top",
        "focus",
        "native-focus",
        "native-activation",
        "revealed",
      ]);
      assert.lengthOf(activateWindowsForegroundMock.mock.calls, 2);
      assert.lengthOf(nativeAppByPidMock.mock.calls, 0);
      assert.lengthOf(readNativeBounds.mock.calls, 1);
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
    "skips native focus only when the foreground matches the %i-byte HWND and process",
    (handleBytes) =>
      Effect.gen(function* () {
        const window = makeWindowsRevealWindow();
        activateWindowsForegroundMock.mockRejectedValueOnce(
          new Error("Windows initially refused foreground activation"),
        );
        const hwnd = handleBytes === 4 ? 0xf123_4567 : 0x1_f123_4567;
        const handle = Buffer.alloc(handleBytes);
        if (handleBytes === 4) handle.writeUInt32LE(hwnd);
        else handle.writeBigUInt64LE(BigInt(hwnd));
        window.getNativeWindowHandle.mockReturnValue(handle);
        activeWindowMock.mockResolvedValue({ id: hwnd, owner: { processId: process.pid } });
        const electronWindow = yield* ElectronWindow.ElectronWindow;

        yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

        assert.lengthOf(nativeAppListMock.mock.calls, 0);
        assert.lengthOf(window.getTitle.mock.calls, 0);
      }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect.each([
    { id: 42, processId: process.pid },
    { id: 41, processId: process.pid + 1 },
  ])("does not mistake another foreground window for the target: %o", (foreground) =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      const focus = vi.fn(async () => undefined);
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      activeWindowMock.mockResolvedValue({
        id: foreground.id,
        owner: { processId: foreground.processId },
      });
      nativeAppListMock.mockResolvedValue([
        {
          pid: process.pid,
          asElement: () => ({ name: window.getTitle(), bounds: window.getBounds(), focus }),
        },
      ]);
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(focus.mock.calls, 1);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("continues native focus when the foreground query fails", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      const focus = vi.fn(async () => undefined);
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      activeWindowMock.mockRejectedValue(new Error("Foreground query unavailable"));
      nativeAppListMock.mockResolvedValue([
        {
          pid: process.pid,
          asElement: () => ({ name: window.getTitle(), bounds: window.getBounds(), focus }),
        },
      ]);
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(focus.mock.calls, 1);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("does not fail reveal when native focus rejects", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      const focus = vi.fn(async () => {
        throw new Error("Focus rejected");
      });
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      nativeAppListMock.mockResolvedValue([
        {
          pid: process.pid,
          asElement: () => ({ name: window.getTitle(), bounds: window.getBounds(), focus }),
        },
      ]);
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(focus.mock.calls, 1);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect("fails reveal when Windows refuses foreground activation", () =>
    Effect.gen(function* () {
      const cause = new Error("Windows refused foreground activation");
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValue(cause);
      const electronWindow = yield* ElectronWindow.ElectronWindow;

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
      const foreground = Promise.withResolvers<undefined>();
      activeWindowMock.mockImplementation(() => {
        queryStarted.resolve();
        return foreground.promise;
      });
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const revealFiber = yield* electronWindow
        .reveal(window as unknown as Electron.BrowserWindow)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => queryStarted.promise);
      window.isDestroyed.mockReturnValue(true);
      foreground.resolve(undefined);
      yield* Fiber.join(revealFiber);

      assert.lengthOf(nativeAppListMock.mock.calls, 0);
      assert.lengthOf(window.getNativeWindowHandle.mock.calls, 1);
      assert.lengthOf(window.getTitle.mock.calls, 0);
    }).pipe(Effect.provide(testLayer("win32"))),
  );

  it.effect.each(["foreground", "destroyed"] as const)(
    "cancels Windows accessibility fallback when the window becomes %s during enumeration",
    (state) =>
      Effect.gen(function* () {
        const asElement = vi.fn();
        const listedApps =
          Promise.withResolvers<Array<{ pid: number; asElement: typeof asElement }>>();
        const listingStarted = Promise.withResolvers<void>();
        nativeAppListMock.mockImplementation(() => {
          listingStarted.resolve();
          return listedApps.promise;
        });
        const window = makeWindowsRevealWindow();
        activateWindowsForegroundMock.mockRejectedValueOnce(
          new Error("Windows initially refused foreground activation"),
        );
        const electronWindow = yield* ElectronWindow.ElectronWindow;

        const revealFiber = yield* electronWindow
          .reveal(window as unknown as Electron.BrowserWindow)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => listingStarted.promise);
        assert.lengthOf(nativeAppListMock.mock.calls, 1);
        if (state === "destroyed") window.isDestroyed.mockReturnValue(true);
        else activeWindowMock.mockResolvedValue({ id: 41, owner: { processId: process.pid } });
        listedApps.resolve([{ pid: process.pid, asElement }]);
        yield* Fiber.join(revealFiber);

        assert.lengthOf(asElement.mock.calls, 0);
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
  it.effect("closes the Windows focus worker when its layer is released", () =>
    Effect.gen(function* () {
      yield* ElectronWindow.ElectronWindow.pipe(Effect.provide(testLayer("win32")));
      assert.lengthOf(windowsForegroundCloseMock.mock.calls, 1);
    }),
  );
});
