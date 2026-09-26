import { it as effectIt } from "@effect/vitest";
import type { DesktopPreviewRecordingFrame } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewEnvironment from "./PreviewEnvironment.ts";
import * as PreviewManager from "./Manager.ts";

describe("preview popup policy", () => {
  it("allows HTTP OAuth windows but never replaces the opener with a denied URL", () => {
    expect(
      PreviewManager.previewWindowOpenAction({
        url: "https://example.com/oauth",
        disposition: "new-window",
      }),
    ).toBe("popup");
    for (const url of ["about:blank", "", "javascript:alert(1)", "file:///tmp/example"]) {
      expect(PreviewManager.previewWindowOpenAction({ url, disposition: "new-window" })).toBe(
        "deny",
      );
    }
  });
});

describe("fitPictureInPictureContentSize", () => {
  it("preserves the PiP content area across aspect-ratio changes", () => {
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 16 / 9)).toEqual([523, 294]);
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 9 / 16)).toEqual([294, 523]);
  });

  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

const {
  browserWindowConstructor,
  createFromPath,
  createFromBuffer,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  createFromBuffer: vi.fn(),
  fromId: vi.fn((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
    createFromBuffer,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

class PreviewListenerDeliveryError extends Error {
  readonly operation: string;
  readonly windowId: number;
  readonly channel: string;

  constructor(input: { operation: string; windowId: number; channel: string }) {
    super(`Failed to deliver ${input.channel} to window ${input.windowId}.`);
    this.operation = input.operation;
    this.windowId = input.windowId;
    this.channel = input.channel;
  }
}

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const environmentLayer = PreviewEnvironment.layer("/tmp/t3/dev/browser-artifacts");

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
);
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toPNG: () => Buffer;
  readonly isEmpty: () => boolean;
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly resize: (size: {
    readonly width: number;
    readonly height: number;
  }) => TestCapturedPreviewImage;
}

const makeTestHostWebContents = () => ({
  id: 1,
  isDestroyed: () => false,
  mainFrame: { frameTreeNodeId: 1 },
  session: { setDisplayMediaRequestHandler: vi.fn() },
  executeJavaScript: vi.fn(async () => true),
  setBackgroundThrottling: vi.fn(),
});

type TestDisplayMediaRequestHandler = (
  request: { readonly frame?: { readonly frameTreeNodeId: number } },
  callback: (response: unknown) => void,
) => void;

const displayMediaRequestHandler = (
  host: ReturnType<typeof makeTestHostWebContents>,
): TestDisplayMediaRequestHandler => {
  const handler = host.session.setDisplayMediaRequestHandler.mock.calls[0]?.[0];
  if (!handler) throw new Error("Display-media request handler was not installed.");
  return handler as TestDisplayMediaRequestHandler;
};

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id: number,
  host = makeTestHostWebContents(),
  debuggerSendCommand: (
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Promise<unknown> = vi.fn(async () => undefined),
) =>
  ({
    id,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => `https://example.com/${id}`,
    getTitle: () => `Example ${id}`,
    isLoading: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    hostWebContents: host,
    mainFrame: { routingId: id },
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: debuggerSendCommand,
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  }) as never;

const makeTestCapturedPreviewImage = (
  data: Buffer,
  width: number,
  height: number,
): TestCapturedPreviewImage => ({
  toJPEG: () => data,
  toPNG: () => data,
  isEmpty: () => width <= 0 || height <= 0,
  getSize: () => ({ width, height }),
  resize: ({ width: resizedWidth, height: resizedHeight }) =>
    makeTestCapturedPreviewImage(data, resizedWidth, resizedHeight),
});

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    createFromBuffer.mockReset();
    webviewSend.mockClear();
  });

  effectIt.effect("shares one capture session between recording and picture-in-picture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("frame"), 1280, 720),
        );
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        fromId.mockImplementation((id) =>
          id === 43 ? replacementWebContents : id === 42 ? firstWebContents : null,
        );
        const closed = vi.fn();
        (
          browserWindowConstructor as unknown as {
            mockImplementation: (implementation: (...args: unknown[]) => unknown) => void;
          }
        ).mockImplementation(function () {
          return {
            isDestroyed: () => false,
            once: vi.fn((event: string, listener: () => void) => {
              if (event === "closed") closed.mockImplementation(listener);
            }),
            setVisibleOnAllWorkspaces: vi.fn(),
            loadURL: vi.fn(async () => undefined),
            showInactive: vi.fn(),
            close: vi.fn(() => closed()),
            webContents: { send: vi.fn() },
          };
        });

        yield* manager.createTab("tab-pip");
        yield* manager.registerWebview("tab-pip", 42);
        yield* manager.startRecording("tab-pip");
        yield* manager.openPictureInPicture("tab-pip");
        yield* manager.stopRecording("tab-pip");
        yield* manager.registerWebview("tab-pip", 43);

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(closed).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("releases an initializing picture-in-picture when its webview is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapture = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("initial"), 1280, 720),
        );
        const replacementCapture = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("replacement"), 1280, 720),
        );
        const initial = makeTestPreviewWebContents(initialCapture, 42);
        const replacement = makeTestPreviewWebContents(replacementCapture, 43);
        fromId.mockImplementation((id) => (id === 42 ? initial : id === 43 ? replacement : null));

        let closedListener: (() => void) | undefined;
        let destroyed = false;
        const window = {
          isDestroyed: () => destroyed,
          once: vi.fn((_event: string, listener: () => void) => {
            closedListener = listener;
          }),
          setVisibleOnAllWorkspaces: vi.fn(),
          loadURL: vi.fn(() => new Promise<void>(() => undefined)),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            destroyed = true;
            closedListener?.();
          }),
          webContents: { send: vi.fn() },
        };
        browserWindowConstructor.mockImplementation(function () {
          return window;
        });

        yield* manager.createTab("tab-replaced");
        yield* manager.registerWebview("tab-replaced", 42);
        const opening = yield* manager
          .openPictureInPicture("tab-replaced")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab-replaced", 43);
        const exit = yield* Fiber.await(opening);

        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(window.close).toHaveBeenCalledOnce();
        expect(window.showInactive).not.toHaveBeenCalled();
        expect(initialCapture).not.toHaveBeenCalled();
        expect(replacementCapture).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("rejects late webview registration and capture starts while closing a tab", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capture = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("frame"), 1280, 720),
        );
        const first = makeTestPreviewWebContents(capture, 42);
        const replacement = makeTestPreviewWebContents(capture, 43);
        const replacementListeners = replacement as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => (id === 42 ? first : id === 43 ? replacement : null));
        let closedListener: (() => void) | undefined;
        let destroyed = false;
        browserWindowConstructor.mockImplementation(function () {
          return {
            isDestroyed: () => destroyed,
            once: vi.fn((_event: string, listener: () => void) => {
              closedListener = listener;
            }),
            setVisibleOnAllWorkspaces: vi.fn(),
            loadURL: vi.fn(async () => undefined),
            showInactive: vi.fn(),
            close: vi.fn(() => {
              destroyed = true;
              closedListener?.();
            }),
            webContents: { send: vi.fn() },
          };
        });

        yield* manager.createTab("tab-closing");
        yield* manager.registerWebview("tab-closing", 42);
        yield* manager.openPictureInPicture("tab-closing");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );
        const closing = yield* manager
          .closeTab("tab-closing")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const lateRegistration = yield* manager
          .registerWebview("tab-closing", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const recreate = yield* manager
          .createTab("tab-closing")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const secondClose = yield* manager
          .closeTab("tab-closing")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListeners.on).not.toHaveBeenCalled();
        const lateCapture = yield* Effect.exit(manager.startRecording("tab-closing"));

        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closing);
        const recreated = yield* Fiber.join(recreate);
        yield* Fiber.join(secondClose);
        const registrationExit = yield* Fiber.await(lateRegistration);
        for (const exit of [registrationExit, lateCapture]) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab-closing",
          });
        }
        expect(replacementListeners.on).not.toHaveBeenCalled();
        expect(replacementListeners.off).not.toHaveBeenCalled();
        expect(replacementListeners.ipc.off).not.toHaveBeenCalled();
        expect(recreated.webContentsId).toBeNull();
        expect(Exit.isFailure(yield* Effect.exit(manager.startRecording("tab-closing")))).toBe(
          true,
        );
      }),
    ),
  );

  effectIt.effect("reopens after close tears down an initializing picture-in-picture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capture = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("frame"), 1280, 720),
        );
        fromId.mockReturnValue(makeTestPreviewWebContents(capture, 42));
        let firstClosed: (() => void) | undefined;
        let firstDestroyed = false;
        const initializingWindow = {
          isDestroyed: () => firstDestroyed,
          once: vi.fn((_event: string, listener: () => void) => {
            firstClosed = listener;
          }),
          setVisibleOnAllWorkspaces: vi.fn(),
          loadURL: vi.fn(() => new Promise<void>(() => undefined)),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            firstDestroyed = true;
            firstClosed?.();
          }),
          webContents: { send: vi.fn() },
        };
        let secondClosed: (() => void) | undefined;
        let secondDestroyed = false;
        const reopenedWindow = {
          isDestroyed: () => secondDestroyed,
          once: vi.fn((_event: string, listener: () => void) => {
            secondClosed = listener;
          }),
          setVisibleOnAllWorkspaces: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            secondDestroyed = true;
            secondClosed?.();
          }),
          webContents: { send: vi.fn() },
        };
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });

        yield* manager.createTab("tab-reopen");
        yield* manager.registerWebview("tab-reopen", 42);
        const opening = yield* manager
          .openPictureInPicture("tab-reopen")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* manager.closePictureInPicture("tab-reopen");

        expect(Exit.hasInterrupts(yield* Fiber.await(opening))).toBe(true);
        expect(initializingWindow.close).toHaveBeenCalledOnce();

        yield* manager.openPictureInPicture("tab-reopen");
        yield* manager.closePictureInPicture("tab-reopen");
        yield* manager.closePictureInPicture("tab-reopen");

        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("cleans up a failed picture-in-picture initialization before a later open", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capture = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("frame"), 1280, 720),
        );
        fromId.mockReturnValue(makeTestPreviewWebContents(capture, 42));
        let failedClosed: (() => void) | undefined;
        let failedDestroyed = false;
        const failedWindow = {
          isDestroyed: () => failedDestroyed,
          once: vi.fn((_event: string, listener: () => void) => {
            failedClosed = listener;
          }),
          setVisibleOnAllWorkspaces: vi.fn(),
          loadURL: vi.fn(async () => Promise.reject(new Error("load failed"))),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            failedDestroyed = true;
            failedClosed?.();
          }),
          webContents: { send: vi.fn() },
        };
        let recoveredClosed: (() => void) | undefined;
        let recoveredDestroyed = false;
        const recoveredWindow = {
          isDestroyed: () => recoveredDestroyed,
          once: vi.fn((_event: string, listener: () => void) => {
            recoveredClosed = listener;
          }),
          setVisibleOnAllWorkspaces: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            recoveredDestroyed = true;
            recoveredClosed?.();
          }),
          webContents: { send: vi.fn() },
        };
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return failedWindow;
          })
          .mockImplementationOnce(function () {
            return recoveredWindow;
          });

        yield* manager.createTab("tab-failed-pip");
        yield* manager.registerWebview("tab-failed-pip", 42);
        const failed = yield* Effect.exit(manager.openPictureInPicture("tab-failed-pip"));

        expect(Exit.isFailure(failed)).toBe(true);
        expect(failedWindow.close).toHaveBeenCalledOnce();

        yield* manager.openPictureInPicture("tab-failed-pip");
        expect(recoveredWindow.showInactive).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new PreviewListenerDeliveryError({
      operation: "send-window-message",
      windowId: 42,
      channel: "preview:state-change",
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(PreviewListenerDeliveryError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        expect(yield* manager.automationStatus("tab_pending")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_pending",
          url: "http://localhost:3200/",
          title: "",
          loading: true,
        });

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("detaches through the pinned debugger after the webview is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        let attached = false;
        const debuggerOff = vi.fn();
        const debuggerDetach = vi.fn(() => {
          attached = false;
        });
        const wcDebugger = {
          isAttached: () => attached,
          attach: vi.fn(() => {
            attached = true;
          }),
          detach: debuggerDetach,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: debuggerOff,
        };
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "http://localhost:3200/",
          getTitle: () => "Preview",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          reload: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          get debugger() {
            if (destroyed) throw new Error("Object has been destroyed");
            return wcDebugger;
          },
        } as never);
        yield* manager.createTab("tab_pinned_debugger");
        yield* manager.registerWebview("tab_pinned_debugger", 42);
        yield* manager.setColorScheme("tab_pinned_debugger", "dark");
        expect(attached).toBe(true);
        destroyed = true;

        yield* manager.navigate("tab_pinned_debugger", "https://example.com/");

        expect(debuggerOff).toHaveBeenCalledWith("message", expect.any(Function));
        expect(debuggerDetach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("preserves tab-owned zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn((zoomFactor: number) => {
          effectiveZoom = zoomFactor;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => effectiveZoom,
          setZoomFactor,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.registerWebview("tab_zoom", 42);

        expect(states.at(-1)?.zoomFactor).toBe(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1);

        const preventDefault = vi.fn();
        listeners.get("before-input-event")?.(
          { preventDefault },
          { type: "keyDown", key: "+", meta: true, control: false, alt: false, shift: true },
        );
        yield* Effect.yieldNow;
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
        expect(effectiveZoom).toBe(1.1);

        effectiveZoom = 1.25;
        url = "https://example.com/next-origin";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
        expect(effectiveZoom).toBe(1.1);

        const replacementSetZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.registerWebview("tab_zoom", 43);

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
      }),
    ),
  );

  effectIt.effect("keeps same-origin tabs in one shared zoom state", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const browserSession = {};
        const listenersById = new Map<number, Map<string, (...args: unknown[]) => void>>();
        const webviews = new Map<number, ReturnType<typeof makeWebview>>();
        let effectiveZoom = 1;

        function makeWebview(id: number) {
          const listeners = new Map<string, (...args: unknown[]) => void>();
          listenersById.set(id, listeners);
          return {
            id,
            session: browserSession,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://example.com/dashboard",
            getTitle: () => "Example",
            isLoading: () => false,
            getZoomFactor: () => effectiveZoom,
            setZoomFactor: vi.fn((zoomFactor: number) => {
              effectiveZoom = zoomFactor;
            }),
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
              listeners.set(event, listener);
            }),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand: vi.fn(async () => undefined),
              on: vi.fn(),
              off: vi.fn(),
            },
          };
        }

        webviews.set(41, makeWebview(41));
        webviews.set(42, makeWebview(42));
        fromId.mockImplementation(
          (id?: number) => (id === undefined ? null : (webviews.get(id) ?? null)) as never,
        );
        const states = new Map<string, PreviewManager.PreviewTabState>();
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            states.set(tabId, state);
          }),
        );

        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 41);
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_b", 42);
        yield* manager.zoomIn("tab_a");

        expect(effectiveZoom).toBe(1.1);
        expect(states.get("tab_a")?.zoomFactor).toBe(1.1);
        expect(states.get("tab_b")?.zoomFactor).toBe(1.1);

        effectiveZoom = 1.25;
        listenersById.get(42)?.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(effectiveZoom).toBe(1.1);
        expect(states.get("tab_a")?.zoomFactor).toBe(1.1);
        expect(states.get("tab_b")?.zoomFactor).toBe(1.1);
      }),
    ),
  );

  effectIt.effect("emulates prefers-color-scheme and re-applies it across webview swaps", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const makeWebContents = (id: number) => {
          const sendCommand = vi.fn(async () => undefined);
          return {
            sendCommand,
            wc: {
              id,
              isDestroyed: () => false,
              isDevToolsOpened: () => false,
              getType: () => "webview",
              getURL: () => "https://example.com",
              getTitle: () => "Example",
              isLoading: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never,
          };
        };
        const first = makeWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_scheme");
        yield* manager.registerWebview("tab_scheme", 42);
        yield* Effect.yieldNow;

        yield* manager.setColorScheme("tab_scheme", "dark");

        expect(first.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        const replacement = makeWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_scheme", 43);
        yield* Effect.yieldNow;

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        yield* manager.setColorScheme("tab_scheme", "system");

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("system");
      }),
    ),
  );

  effectIt.effect("keeps load failures visible and finishes on main-frame completion", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        listeners.get("did-finish-load")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValue(captureCause);
        const exitFiber = yield* Effect.forkChild(Effect.exit(manager.captureScreenshot("tab_1")));
        yield* TestClock.adjust("1 second");
        const exit = yield* Fiber.join(exitFiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect(
    "captures automation screenshots from CDP when the guest surface is unavailable",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const png = Buffer.from("captured-cdp-png");
          const image = makeTestCapturedPreviewImage(png, 1280, 800);
          const capturePage = vi.fn(async () => {
            throw new Error("UnknownVizError");
          });
          const sendCommand = vi.fn(async (method: string) => {
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value: {
                    url: "about:blank",
                    title: "",
                    loading: false,
                    visibleText: "",
                    interactiveElements: [],
                  },
                },
              };
            }
            if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
            return undefined;
          });
          createFromBuffer.mockReturnValue(image);
          fromId.mockReturnValue(
            makeTestPreviewWebContents(capturePage, 42, undefined, sendCommand),
          );

          yield* manager.createTab("tab_snapshot_cdp");
          yield* manager.registerWebview("tab_snapshot_cdp", 42);
          const snapshot = yield* manager.automationSnapshot("tab_snapshot_cdp");

          expect(capturePage).not.toHaveBeenCalled();
          expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
          });
          expect(createFromBuffer).toHaveBeenCalledWith(png);
          expect(snapshot).toMatchObject({
            url: "about:blank",
            visibleText: "",
            screenshot: {
              data: png.toString("base64"),
              width: 1280,
              height: 800,
            },
          });
        }),
      ),
  );

  effectIt.effect(
    "retains page diagnostics and releases control after stalled screenshot capture",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const png = Buffer.from("recovered-cdp-png");
          const image = makeTestCapturedPreviewImage(png, 1280, 800);
          const capturePage = vi.fn(async () =>
            makeTestCapturedPreviewImage(Buffer.alloc(0), 0, 0),
          );
          let stalled = true;
          const sendCommand = vi.fn((method: string) => {
            if (method === "Runtime.evaluate") {
              return Promise.resolve({
                result: {
                  value: {
                    url: "https://example.com/",
                    title: "Example",
                    loading: false,
                    visibleText: "Rendered page diagnostics",
                    interactiveElements: [],
                  },
                },
              });
            }
            if (method === "Page.captureScreenshot") {
              return stalled
                ? new Promise<never>(() => {})
                : Promise.resolve({ data: png.toString("base64") });
            }
            return Promise.resolve(undefined);
          });
          createFromBuffer.mockReturnValue(image);
          fromId.mockReturnValue(
            makeTestPreviewWebContents(capturePage, 42, undefined, sendCommand),
          );

          yield* manager.createTab("tab_snapshot_timeout");
          yield* manager.registerWebview("tab_snapshot_timeout", 42);
          const snapshotFiber = yield* manager
            .automationSnapshot("tab_snapshot_timeout")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          for (let attempt = 0; attempt < 3; attempt += 1) {
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
            if (attempt < 2) {
              yield* TestClock.adjust(200);
              yield* Effect.yieldNow;
            }
          }

          const failedCaptureSnapshot = yield* Fiber.join(snapshotFiber);
          expect(failedCaptureSnapshot).toMatchObject({
            url: "https://example.com/",
            visibleText: "Rendered page diagnostics",
            screenshot: { data: "", width: 0, height: 0 },
            screenshotCaptureFailure: {
              _tag: "PreviewScreenshotCaptureFailed",
              operation: "Page.captureScreenshot",
            },
            diagnosticsSummary: expect.stringContaining("visibleText: 25 chars"),
          });
          expect(
            sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot"),
          ).toHaveLength(3);

          stalled = false;
          const recoveredSnapshot = yield* manager.automationSnapshot("tab_snapshot_timeout");
          expect(recoveredSnapshot.screenshot).toMatchObject({
            data: png.toString("base64"),
            width: 1280,
            height: 800,
          });
          expect(capturePage).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect("arms native recording capture without delivering JPEG frames", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () =>
          makeTestCapturedPreviewImage(Buffer.from("warm-frame"), 800, 600),
        );
        const host = makeTestHostWebContents();
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        yield* manager.startRecording("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(host.session.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
        expect(host.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("tab_1"), true);
        expect(frames).toEqual([]);

        const handler = displayMediaRequestHandler(host);
        const mismatchedGrant = vi.fn();
        handler({ frame: { frameTreeNodeId: 2 } }, mismatchedGrant);
        expect(mismatchedGrant).toHaveBeenCalledWith({});

        const matchingGrant = vi.fn();
        handler({ frame: { frameTreeNodeId: 1 } }, matchingGrant);
        expect(matchingGrant).toHaveBeenCalledWith({
          video: (guest as unknown as { readonly mainFrame: unknown }).mainFrame,
        });

        const consumedGrant = vi.fn();
        handler({ frame: { frameTreeNodeId: 1 } }, consumedGrant);
        expect(consumedGrant).toHaveBeenCalledWith({});

        yield* manager.stopRecording("tab_1");
      }),
    ),
  );

  effectIt.effect("denies display-media grants when the armed source is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        const host = makeTestHostWebContents();
        const guest = makeTestPreviewWebContents(
          vi.fn(async () => makeTestCapturedPreviewImage(Buffer.from("warm-frame"), 800, 600)),
          42,
          host,
        ) as unknown as {
          isDestroyed: () => boolean;
        };
        guest.isDestroyed = () => destroyed;
        fromId.mockReturnValue(guest as never);

        yield* manager.createTab("tab_destroyed_capture");
        yield* manager.registerWebview("tab_destroyed_capture", 42);
        yield* manager.startRecording("tab_destroyed_capture");
        destroyed = true;

        const callback = vi.fn();
        displayMediaRequestHandler(host)({ frame: { frameTreeNodeId: 1 } }, callback);
        expect(callback).toHaveBeenCalledWith({});

        destroyed = false;
        const staleCallback = vi.fn();
        displayMediaRequestHandler(host)({ frame: { frameTreeNodeId: 1 } }, staleCallback);
        expect(staleCallback).toHaveBeenCalledWith({});
        yield* manager.stopRecording("tab_destroyed_capture");
      }),
    ),
  );

  effectIt.effect("bounds each recording compositor warm-up attempt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(() => new Promise<TestCapturedPreviewImage>(() => {}));
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_warm_timeout");
        yield* manager.registerWebview("tab_warm_timeout", 42);
        const startFiber = yield* manager
          .startRecording("tab_warm_timeout")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(capturePage).toHaveBeenCalledOnce();

        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        expect(capturePage).toHaveBeenCalledTimes(2);

        yield* TestClock.adjust("1 second");
        yield* Fiber.join(startFiber);
        yield* manager.stopRecording("tab_warm_timeout");
      }),
    ),
  );

  it("derives recording extensions from the actual media subtype", () => {
    expect(PreviewManager.recordingFileExtension("video/mp4;codecs=avc1")).toBe("mp4");
    expect(PreviewManager.recordingFileExtension("video/x-matroska")).toBe("matroska");
    expect(PreviewManager.recordingFileExtension("")).toBe("video");
  });

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({}, "about:blank", false, false);
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({}, "https://example.com/next", false, true);
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(writeImage).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({ isEmpty: () => true });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });
      }),
    ),
  );

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("types in background webviews and enables native key input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (
            failKeyDown &&
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            throw new Error("key dispatch failed");
          }
          if (
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            humanInput?.(
              {},
              {
                kind: "key",
                key: params["key"],
                code: params["code"] ?? "Digit1",
              },
            );
          }
          return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
        });
        const restoreFocus = vi.fn();
        const focus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );
        const keyDownIndex = calls.findIndex(
          ([method, params]) =>
            method === "Input.dispatchKeyEvent" && params?.["type"] === "keyDown",
        );
        const keyUpIndex = calls.findIndex(
          ([method, params]) => method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
        );
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('document.execCommand("insertText"'),
        );
        expect(typeEvaluation).toBeDefined();
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );
        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(focus).toHaveBeenCalledOnce();
        expect(restoreFocus).toHaveBeenCalledOnce();
        expect(methods).toContain("Page.bringToFront");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(focusOnIndex).toBeLessThan(keyDownIndex);
        expect(keyDownIndex).toBeLessThan(keyUpIndex);
        expect(keyUpIndex).toBeLessThan(focusOffIndex);
        expect(
          calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });

        sendCommand.mockClear();
        failKeyDown = true;
        const failedPress = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));

        expect(Exit.isFailure(failedPress)).toBe(true);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "y",
          code: "KeyY",
          modifiers: 0,
          windowsVirtualKeyCode: 89,
          location: 0,
          isKeypad: false,
        });
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        expect(restoreFocus).toHaveBeenCalledTimes(2);
        expect(
          sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);

        sendCommand.mockClear();
        failKeyDown = false;
        yield* manager.automationPress("tab_input", { key: "!" });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "!",
          code: "Digit1",
          modifiers: 0,
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
          text: "!",
          unmodifiedText: "!",
        });
        expect(restoreFocus).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});
