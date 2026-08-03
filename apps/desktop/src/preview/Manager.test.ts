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

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

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

describe("isPreviewRefreshShortcut", () => {
  const input = (overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key: "r",
      meta: true,
      control: false,
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes the platform refresh chord without matching modified variants", () => {
    expect(PreviewManager.isPreviewRefreshShortcut(input())).toBe(true);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ meta: false, control: true }))).toBe(
      true,
    );
    expect(PreviewManager.isPreviewRefreshShortcut(input({ shift: true }))).toBe(false);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ type: "keyUp" }))).toBe(false);
  });
});

const {
  browserWindowConstructor,
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromBuffer: vi.fn(
    (
      buffer: Buffer,
    ): {
      readonly getSize: () => { readonly width: number; readonly height: number };
      readonly isEmpty: () => boolean;
      readonly toDataURL: () => string;
      readonly resize: (size: { width?: number; height?: number }) => {
        readonly toDataURL: () => string;
      };
    } => ({
      getSize: () => ({ width: 16, height: 16 }),
      isEmpty: () => false,
      toDataURL: () => `data:image/png;base64,${buffer.toString("base64")}`,
      resize: () => ({
        toDataURL: () => `data:image/png;base64,${buffer.toString("base64")}`,
      }),
    }),
  ),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
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
    createFromBuffer,
    createFromPath,
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

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

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
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
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
  readonly getSize: () => { readonly width: number; readonly height: number };
}

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
) =>
  ({
    id,
    isDestroyed: () => false,
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
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  }) as never;

const makeFaviconWebContents = (options: {
  readonly id?: number;
  readonly url: string;
  readonly title: string;
  readonly fetch: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<unknown>;
  readonly loading?: boolean;
  readonly loadURL?: (url: string) => Promise<void>;
  readonly rasterizedFavicon?: string | null | ((code: string) => string | null);
}) => {
  const { id = 42, url, title, fetch } = options;
  let currentUrl = url;
  let loading = options.loading ?? false;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const reload = vi.fn();
  const reloadIgnoringCache = vi.fn();
  const loadURL = vi.fn(async (nextUrl: string) => {
    currentUrl = nextUrl;
    await options.loadURL?.(nextUrl);
  });
  const stop = vi.fn(() => {
    loading = false;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ code: string }>) => {
      const result = options.rasterizedFavicon;
      return typeof result === "function" ? result(scripts[0]?.code ?? "") : (result ?? null);
    },
  );
  const webContents = {
    id,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => currentUrl,
    getTitle: () => title,
    isLoading: () => loading,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    reload,
    reloadIgnoringCache,
    stop,
    loadURL,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    session: { fetch },
  } as never;
  return {
    webContents,
    listeners,
    reload,
    reloadIgnoringCache,
    loadURL,
    stop,
    executeJavaScriptInIsolatedWorld,
    setUrl: (nextUrl: string) => {
      currentUrl = nextUrl;
    },
    setLoading: (nextLoading: boolean) => {
      loading = nextLoading;
    },
  };
};

// Lets pending microtasks (fetch resolution, favicon publication) drain
// before an assertion runs. `extra` gives incorrect-publication paths a few
// more ticks to surface before we assert on their absence.
const settle = function* (until: () => boolean, extra = 5) {
  for (let i = 0; i < 20 && !until(); i++) {
    yield* Effect.promise(() => Promise.resolve());
    yield* Effect.yieldNow;
  }
  for (let i = 0; i < extra; i++) {
    yield* Effect.promise(() => Promise.resolve());
    yield* Effect.yieldNow;
  }
};

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const listeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    webContents: {
      send,
    },
  };
  return { pictureInPictureWindow, send };
};

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
    webviewSend.mockClear();
  });

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
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
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
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
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

  effectIt.effect("does not hold the tab lifecycle lock while a page load is pending", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFirstLoad!: () => void;
        const firstLoad = new Promise<void>((resolve) => {
          resolveFirstLoad = resolve;
        });
        let loadCount = 0;
        const { webContents, loadURL } = makeFaviconWebContents({
          url: "http://localhost:3200/",
          title: "Pending navigation",
          fetch: vi.fn(),
          loadURL: () => (++loadCount === 1 ? firstLoad : Promise.resolve()),
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_pending_lifecycle");
        yield* manager.registerWebview("tab_pending_lifecycle", 42);

        const firstFiber = yield* manager
          .navigate("tab_pending_lifecycle", "http://localhost:3201/")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* settle(() => loadURL.mock.calls.length === 1, 0);

        let secondFinished = false;
        const secondFiber = yield* manager
          .navigate("tab_pending_lifecycle", "http://localhost:3202/")
          .pipe(
            Effect.ensuring(Effect.sync(() => (secondFinished = true))),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* settle(() => secondFinished, 0);
        const secondFinishedBeforeFirstLoad = secondFinished;

        let closeFinished = false;
        const closeFiber = yield* manager
          .closeTab("tab_pending_lifecycle")
          .pipe(
            Effect.ensuring(Effect.sync(() => (closeFinished = true))),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* settle(() => closeFinished, 0);
        const closeFinishedBeforeFirstLoad = closeFinished;

        resolveFirstLoad();
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        yield* Fiber.join(closeFiber);

        expect(loadURL).toHaveBeenCalledTimes(2);
        expect(secondFinishedBeforeFirstLoad).toBe(true);
        expect(closeFinishedBeforeFirstLoad).toBe(true);
      }),
    ),
  );

  effectIt.effect("does not fail a navigation superseded by a newer load", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let rejectFirstLoad!: (cause: Error) => void;
        let loadCount = 0;
        const { webContents, loadURL } = makeFaviconWebContents({
          url: "http://localhost:3203/current",
          title: "Superseded navigation",
          fetch: vi.fn(),
          loadURL: () => {
            loadCount += 1;
            return loadCount === 1
              ? new Promise<void>((_resolve, reject) => {
                  rejectFirstLoad = reject;
                })
              : Promise.resolve();
          },
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_superseded_navigation");
        yield* manager.registerWebview("tab_superseded_navigation", 42);

        const first = yield* manager
          .navigate("tab_superseded_navigation", "http://localhost:3203/first")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* settle(() => loadURL.mock.calls.length === 1, 0);
        yield* manager.navigate("tab_superseded_navigation", "http://localhost:3203/second");
        rejectFirstLoad(new Error("ERR_ABORTED (-3) loading the superseded URL"));

        yield* Fiber.join(first);
        expect(loadURL).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("still reports non-abort navigation failures", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { webContents } = makeFaviconWebContents({
          url: "http://localhost:3204/current",
          title: "Failed navigation",
          fetch: vi.fn(),
          loadURL: () => Promise.reject(new Error("ERR_CONNECTION_REFUSED")),
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_failed_navigation");
        yield* manager.registerWebview("tab_failed_navigation", 42);

        const exit = yield* Effect.exit(
          manager.navigate("tab_failed_navigation", "http://localhost:3204/failed"),
        );

        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ),
  );

  effectIt.effect("starts navigation before a queued toolbar action can supersede it", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const targetUrl = "http://localhost:3203/next";
        const { webContents, loadURL, reload } = makeFaviconWebContents({
          url: "http://localhost:3203/current",
          title: "Queued toolbar action",
          fetch: vi.fn(),
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_queued_toolbar_action");
        yield* manager.registerWebview("tab_queued_toolbar_action", 42);

        const loadingPublished = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((tabId, state) => {
          if (
            tabId !== "tab_queued_toolbar_action" ||
            state.navStatus.kind !== "Loading" ||
            state.navStatus.url !== targetUrl
          ) {
            return Effect.void;
          }
          return Deferred.succeed(loadingPublished, undefined).pipe(Effect.asVoid);
        });
        const toolbarAction = yield* Deferred.await(loadingPublished).pipe(
          Effect.andThen(manager.refresh("tab_queued_toolbar_action")),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* manager.navigate("tab_queued_toolbar_action", targetUrl);
        yield* Fiber.join(toolbarAction);

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith(targetUrl);
        expect(reload).toHaveBeenCalledOnce();
        expect(loadURL.mock.invocationCallOrder[0]).toBeLessThan(
          reload.mock.invocationCallOrder[0]!,
        );
      }),
    ),
  );

  effectIt.effect("stops a pending load without replacing the current favicon", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:3203";
        const currentUrl = `${origin}/current`;
        const nextUrl = `${origin}/next`;
        const currentFaviconUrl = `${origin}/current.png`;
        const nextFaviconUrl = `${origin}/next.png`;
        const currentBytes = Buffer.from("current-page-favicon");
        const nextBytes = Buffer.from("favicon-from-aborted-load");
        const fetch = vi.fn(async (url: string) => {
          const bytes = url === currentFaviconUrl ? currentBytes : nextBytes;
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners, reload, setLoading, setUrl, stop } = makeFaviconWebContents(
          {
            url: currentUrl,
            title: "Pending load",
            fetch,
          },
        );
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_stop_loading");
        yield* manager.registerWebview("tab_stop_loading", 42);
        listeners.get("page-favicon-updated")?.({}, [currentFaviconUrl]);
        const currentFavicon = `data:image/png;base64,${currentBytes.toString("base64")}`;
        yield* settle(() => states.at(-1)?.favicon === currentFavicon);

        yield* manager.navigate("tab_stop_loading", nextUrl);
        setLoading(true);
        listeners.get("page-favicon-updated")?.({}, [nextFaviconUrl]);
        yield* settle(() => false);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(states.at(-1)?.navStatus).toMatchObject({ kind: "Loading", url: nextUrl });
        expect(states.at(-1)?.favicon).toBe(currentFavicon);

        yield* manager.refresh("tab_stop_loading");
        setUrl(currentUrl);
        listeners.get("did-fail-load")?.({}, -3, "ERR_ABORTED", nextUrl, true);
        listeners.get("did-stop-loading")?.();
        yield* settle(() => false);

        expect(stop).toHaveBeenCalledOnce();
        expect(reload).not.toHaveBeenCalled();
        expect(states.at(-1)?.navStatus).toMatchObject({ kind: "Success", url: currentUrl });
        expect(states.at(-1)?.favicon).toBe(currentFavicon);
        expect(states.at(-1)?.faviconOrigin).toBe(origin);
      }),
    ),
  );

  effectIt.effect("mirrors Electron's effective zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => {
            if (!zoomReadable) throw new Error("zoom unavailable");
            return effectiveZoom;
          },
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

        expect(states.at(-1)?.zoomFactor).toBe(0.9);
        expect(setZoomFactor).not.toHaveBeenCalled();

        effectiveZoom = 1.25;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.25);
        expect(setZoomFactor).not.toHaveBeenCalled();

        zoomReadable = false;
        url = "https://example.com/after-zoom-read-failed";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1.25);

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

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.25);
        expect(states.at(-1)?.zoomFactor).toBe(1.25);
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

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit]) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
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
      }),
    ),
  );

  effectIt.effect("clears a stale favicon when a main-frame navigation fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5737";
        const bytes = Buffer.from("published-before-navigation-failure");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/current`,
          title: "Current page",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_failed_navigation");
        yield* manager.registerWebview("tab_favicon_failed_navigation", 42);

        listeners.get("page-favicon-updated")?.({}, [`${origin}/favicon.png`]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          `${origin}/subframe`,
          false,
        );
        yield* Effect.yieldNow;
        expect(states.at(-1)?.favicon).toBeDefined();

        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-fail-load")?.({}, -3, "ERR_ABORTED", `${origin}/aborted`, true);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.navStatus.kind).toBe("Success");
        expect(states.at(-1)?.favicon).toBeDefined();

        const failedUrl = `${origin}/failed`;
        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", failedUrl, true);
        yield* settle(() => states.at(-1)?.navStatus.kind === "LoadFailed");

        expect(states.at(-1)?.navStatus).toMatchObject({
          kind: "LoadFailed",
          url: failedUrl,
        });
        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(states.at(-1)?.faviconOrigin).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("captures a favicon onto the tab state", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        const png = Buffer.from("tiny-png-bytes-but-above-min");
        const brokenFavicon = "http://localhost:5733/broken.ico";
        const fetch = vi.fn(async (faviconUrl: string) =>
          faviconUrl === brokenFavicon
            ? { ok: false }
            : {
                ok: true,
                arrayBuffer: async () =>
                  png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
                headers: {
                  get: (name: string) => (name === "content-type" ? "Image/X-Icon" : null),
                },
              },
        );
        const { webContents, listeners } = makeFaviconWebContents({
          url,
          title: "localhost:5733",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon");
        yield* manager.registerWebview("tab_favicon", 42);

        expect(listeners.has("page-favicon-updated")).toBe(true);
        const inlineFavicon =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        listeners.get("page-favicon-updated")?.({}, [
          "file:///tmp/favicon.png",
          brokenFavicon,
          inlineFavicon,
        ]);

        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(fetch).toHaveBeenNthCalledWith(1, brokenFavicon, {
          credentials: "include",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon).toBe(inlineFavicon);
        expect(states.at(-1)?.faviconOrigin).toBe("http://localhost:5733");
      }),
    ),
  );

  effectIt.effect("decodes headerless and generic binary favicon responses", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5744";
        const headerlessUrl = `${origin}/headerless.ico`;
        const genericUrl = `${origin}/generic.ico`;
        const unsupportedUrl = `${origin}/not-an-image`;
        const fetch = vi.fn(async (url: string) => {
          const bytes = Buffer.from(url);
          const contentType =
            url === headerlessUrl
              ? null
              : url === genericUrl
                ? "application/octet-stream"
                : "text/html";
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? contentType : null) },
          };
        });
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Generic favicon responses",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_generic_mime");
        yield* manager.registerWebview("tab_favicon_generic_mime", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [headerlessUrl]);
        const headerlessFavicon = `data:image/png;base64,${Buffer.from(headerlessUrl).toString("base64")}`;
        yield* settle(() => states.at(-1)?.favicon === headerlessFavicon);

        faviconUpdated?.({}, [genericUrl]);
        const genericFavicon = `data:image/png;base64,${Buffer.from(genericUrl).toString("base64")}`;
        yield* settle(() => states.at(-1)?.favicon === genericFavicon);

        const decodeCount = createFromBuffer.mock.calls.length;
        faviconUpdated?.({}, [unsupportedUrl]);
        yield* settle(() => false);

        expect(createFromBuffer).toHaveBeenCalledTimes(decodeCount);
        expect(states.at(-1)?.favicon).toBe(genericFavicon);
      }),
    ),
  );

  effectIt.effect("publishes a loading-time favicon after a later candidate fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5738";
        const bytes = Buffer.from("favicon-during-load");
        const failedUrl = `${origin}/missing.png`;
        const fetch = vi.fn(async (url: string) =>
          url === failedUrl
            ? { ok: false }
            : {
                ok: true,
                arrayBuffer: async () =>
                  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                headers: {
                  get: (name: string) => (name === "content-type" ? "image/png" : null),
                },
              },
        );
        const { webContents, listeners, setLoading } = makeFaviconWebContents({
          url: `${origin}/app`,
          title: "Loading favicon",
          fetch,
          loading: true,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_loading");
        yield* manager.registerWebview("tab_favicon_loading", 42);

        const faviconUrl = `${origin}/favicon.png`;
        listeners.get("page-favicon-updated")?.({}, [faviconUrl, `${origin}/fallback.png`]);
        yield* settle(() => fetch.mock.calls.length === 1);
        expect(states.at(-1)?.navStatus.kind).toBe("Loading");
        expect(states.at(-1)?.favicon).toBeUndefined();
        listeners.get("page-favicon-updated")?.({}, [faviconUrl]);
        yield* settle(() => false);
        expect(fetch).toHaveBeenCalledOnce();
        listeners.get("page-favicon-updated")?.({}, [failedUrl]);
        yield* settle(() => fetch.mock.calls.length === 2);

        setLoading(false);
        listeners.get("did-stop-loading")?.();
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.navStatus.kind).toBe("Success");
        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
      }),
    ),
  );

  effectIt.effect("decodes percent-encoded inline favicons without fetching", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const fetch = vi.fn(async () => ({ ok: false }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: "http://localhost:5741/",
          title: "Inline SVG",
          fetch,
          rasterizedFavicon: "data:image/png;base64,RASTERIZED",
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_inline_svg");
        yield* manager.registerWebview("tab_favicon_inline_svg", 42);

        const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        listeners.get("page-favicon-updated")?.({}, ["data:image/png,%89PNG%0D%0A%1A%0A"]);
        yield* settle(
          () => states.at(-1)?.favicon === `data:image/png;base64,${binary.toString("base64")}`,
        );

        listeners.get("page-favicon-updated")?.({}, [
          "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E",
        ]);
        yield* settle(() => states.at(-1)?.favicon === "data:image/png;base64,RASTERIZED");

        expect(fetch).not.toHaveBeenCalled();
        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,RASTERIZED");
      }),
    ),
  );

  effectIt.effect("omits credentials for cross-origin favicon requests", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const bytes = Buffer.from("cross-origin-favicon");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: "http://localhost:5739/",
          title: "Cross-origin favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_favicon_cross_origin");
        yield* manager.registerWebview("tab_favicon_cross_origin", 42);

        const faviconUrl = "https://static.example.test/favicon.png";
        listeners.get("page-favicon-updated")?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 1);

        expect(fetch).toHaveBeenCalledWith(faviconUrl, {
          credentials: "omit",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      }),
    ),
  );

  effectIt.effect("normalizes animated favicon formats to a static PNG", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const bytes = Buffer.from("animated-favicon");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/gif" : null) },
        }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: "http://localhost:5742/",
          title: "Animated favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_animated");
        yield* manager.registerWebview("tab_favicon_animated", 42);

        listeners.get("page-favicon-updated")?.({}, ["http://localhost:5742/favicon.gif"]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
      }),
    ),
  );

  effectIt.effect("preserves aspect ratio while bounding bitmap favicons", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const landscapeResize = vi.fn(() => ({
          toDataURL: () => "data:image/png;base64,LANDSCAPE",
        }));
        const portraitResize = vi.fn(() => ({
          toDataURL: () => "data:image/png;base64,PORTRAIT",
        }));
        const smallResize = vi.fn(() => ({
          toDataURL: () => "data:image/png;base64,RESIZED_SMALL",
        }));
        createFromBuffer
          .mockReturnValueOnce({
            getSize: () => ({ width: 64, height: 16 }),
            isEmpty: () => false,
            toDataURL: () => "data:image/png;base64,UNRESIZED_LANDSCAPE",
            resize: landscapeResize,
          })
          .mockReturnValueOnce({
            getSize: () => ({ width: 16, height: 64 }),
            isEmpty: () => false,
            toDataURL: () => "data:image/png;base64,UNRESIZED_PORTRAIT",
            resize: portraitResize,
          })
          .mockReturnValueOnce({
            getSize: () => ({ width: 24, height: 12 }),
            isEmpty: () => false,
            toDataURL: () => "data:image/png;base64,SMALL",
            resize: smallResize,
          });
        const origin = "http://localhost:5743";
        const fetch = vi.fn(async (url: string) => {
          const bytes = Buffer.from(url);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Non-square favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_aspect_ratio");
        yield* manager.registerWebview("tab_favicon_aspect_ratio", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [`${origin}/landscape.png`]);
        yield* settle(() => states.at(-1)?.favicon === "data:image/png;base64,LANDSCAPE");
        faviconUpdated?.({}, [`${origin}/portrait.png`]);
        yield* settle(() => states.at(-1)?.favicon === "data:image/png;base64,PORTRAIT");
        faviconUpdated?.({}, [`${origin}/small.png`]);
        yield* settle(() => states.at(-1)?.favicon === "data:image/png;base64,SMALL");

        expect(landscapeResize).toHaveBeenCalledWith({ width: 32 });
        expect(portraitResize).toHaveBeenCalledWith({ height: 32 });
        expect(smallResize).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("bounds favicon candidates and URL length before fetching", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const fetch = vi.fn(async () => ({ ok: false }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: "http://localhost:5740/",
          title: "Bounded favicons",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        yield* manager.createTab("tab_favicon_bounds");
        yield* manager.registerWebview("tab_favicon_bounds", 42);

        const candidates = Array.from(
          { length: 10 },
          (_, index) => `http://localhost:5740/favicon-${index}.png`,
        );
        listeners.get("page-favicon-updated")?.({}, candidates);
        yield* settle(() => fetch.mock.calls.length === 8);
        listeners.get("page-favicon-updated")?.({}, [
          `http://localhost:5740/${"x".repeat(2_100)}.png`,
        ]);
        const decodesBeforeOversizedInline = createFromBuffer.mock.calls.length;
        listeners.get("page-favicon-updated")?.({}, [
          `data:image/png;base64,${"A".repeat(140_000)}`,
        ]);
        yield* settle(() => false);

        expect(fetch).toHaveBeenCalledTimes(8);
        expect(fetch).not.toHaveBeenCalledWith(candidates[8], expect.anything());
        expect(createFromBuffer).toHaveBeenCalledTimes(decodesBeforeOversizedInline);
      }),
    ),
  );

  effectIt.effect("keeps a favicon within its origin and clears it on an origin change", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5734";
        const bytes = Buffer.from("navigation-favicon-bytes");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: {
            get: (name: string) => (name === "content-type" ? "image/png" : null),
          },
        }));
        const { webContents, listeners, setLoading, setUrl } = makeFaviconWebContents({
          url: `${origin}/first`,
          title: "Navigation favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_document_navigation");
        yield* manager.registerWebview("tab_favicon_document_navigation", 42);

        listeners.get("page-favicon-updated")?.({}, [`${origin}/favicon.png`]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        setUrl(`${origin}/first#section`);
        listeners.get("did-navigate-in-page")?.();
        yield* Effect.yieldNow;
        expect(states.at(-1)?.favicon).toBeDefined();

        setUrl(`${origin}/second`);
        setLoading(true);
        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(states.at(-1)?.navStatus.kind).toBe("Loading");
        expect(states.at(-1)?.favicon).toBeDefined();
        expect(states.at(-1)?.faviconOrigin).toBe(origin);
        setLoading(false);
        listeners.get("did-stop-loading")?.();

        setUrl("https://example.com/");
        setLoading(true);
        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-navigate")?.();
        yield* settle(() => states.at(-1)?.favicon === undefined);
        expect(states.at(-1)?.faviconOrigin).toBeUndefined();
        setLoading(false);
        listeners.get("did-stop-loading")?.();
        expect(fetch).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("does not let a stale favicon capture overwrite a newer one", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5749";
        const pending = new Map<string, (response: unknown) => void>();
        const fetch = vi.fn(
          (url: string, init?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              pending.set(url, resolve);
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "localhost:5749",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_race");
        yield* manager.registerWebview("tab_favicon_race", 42);

        const firstUrl = `${origin}/first.png`;
        const firstFallbackUrl = `${origin}/first-fallback.png`;
        const secondUrl = `${origin}/second.png`;
        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [firstUrl, firstFallbackUrl]);
        yield* settle(() => fetch.mock.calls.length === 1, 0);
        const firstSignal = fetch.mock.calls[0]?.[1]?.signal;
        faviconUpdated?.({}, [secondUrl]);
        yield* settle(() => fetch.mock.calls.length === 2, 0);
        expect(firstSignal?.aborted).toBe(true);

        const response = (bytes: Buffer) => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        });
        const newest = Buffer.from("newest-favicon-bytes");
        pending.get(secondUrl)?.(response(newest));
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).not.toHaveBeenCalledWith(firstFallbackUrl, expect.anything());
        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${newest.toString("base64")}`);
      }),
    ),
  );

  effectIt.effect("does not try stale favicon fallbacks after a newer capture starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5760";
        const pending = new Map<string, (response: unknown) => void>();
        const fetch = vi.fn(
          (url: string, init?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              pending.set(url, resolve);
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "localhost:5760",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_failed_race");
        yield* manager.registerWebview("tab_favicon_failed_race", 42);

        const staleUrl = `${origin}/stale.png`;
        const staleFallbackUrl = `${origin}/stale-fallback.png`;
        const newestUrl = `${origin}/newest.png`;
        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [staleUrl, staleFallbackUrl]);
        yield* settle(() => fetch.mock.calls.length === 1, 0);
        faviconUpdated?.({}, [newestUrl]);
        yield* settle(() => fetch.mock.calls.length === 2, 0);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).not.toHaveBeenCalledWith(staleFallbackUrl, expect.anything());

        const newest = Buffer.from("newest-favicon-after-stale-failure");
        pending.get(newestUrl)?.({
          ok: true,
          arrayBuffer: async () =>
            newest.buffer.slice(newest.byteOffset, newest.byteOffset + newest.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        });
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${newest.toString("base64")}`);
      }),
    ),
  );

  effectIt.effect("shares an identical favicon event while its capture is in flight", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5762";
        const bytes = Buffer.from("deduplicated-favicon");
        let resolveFetch!: (response: unknown) => void;
        const fetch = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveFetch = resolve;
            }),
        );
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Duplicate favicon event",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_duplicate");
        yield* manager.registerWebview("tab_favicon_duplicate", 42);

        const faviconUrl = `${origin}/favicon.png`;
        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [faviconUrl]);
        faviconUpdated?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length > 0, 0);

        expect(fetch).toHaveBeenCalledOnce();

        resolveFetch({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        });
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
      }),
    ),
  );

  effectIt.effect("captures a changed favicon URL on the same origin", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5755";
        const fetch = vi.fn(async (faviconUrl: string) => {
          const bytes = Buffer.from(faviconUrl);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Dynamic favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_dynamic");
        yield* manager.registerWebview("tab_favicon_dynamic", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [`${origin}/first.png`]);
        yield* settle(() => fetch.mock.calls.length === 1 && states.at(-1)?.favicon !== undefined);
        faviconUpdated?.({}, [`${origin}/second.png`]);
        yield* settle(() => fetch.mock.calls.length === 2);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(states.at(-1)?.favicon).toBe(
          `data:image/png;base64,${Buffer.from(`${origin}/second.png`).toString("base64")}`,
        );
      }),
    ),
  );

  effectIt.effect("keeps the page origin from the favicon event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const siteA = "http://localhost:5756";
        const siteB = "http://localhost:5757";
        const bytes = Buffer.from("site-a-favicon");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners, setUrl } = makeFaviconWebContents({
          url: `${siteA}/`,
          title: "Site A",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_event_origin");
        yield* manager.registerWebview("tab_favicon_event_origin", 42);

        listeners.get("page-favicon-updated")?.({}, [`${siteA}/favicon.png`]);
        setUrl(`${siteB}/`);
        yield* settle(() => fetch.mock.calls.length === 1);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(states.at(-1)?.faviconOrigin).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("cancels a favicon response when its stream exceeds the byte limit", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(60_000));
            controller.enqueue(new Uint8Array(60_000));
          },
          cancel() {
            cancelled = true;
          },
        });
        const fetch = vi.fn(async () => ({
          ok: true,
          body,
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners } = makeFaviconWebContents({
          url: "http://localhost:5758/",
          title: "Oversized favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_oversized");
        yield* manager.registerWebview("tab_favicon_oversized", 42);

        listeners.get("page-favicon-updated")?.({}, ["http://localhost:5758/oversized.png"]);
        yield* settle(() => cancelled);

        expect(cancelled).toBe(true);
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("recaptures a favicon after navigating to the current URL", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5754/";
        const fetch = vi.fn(async () => {
          const bytes = Buffer.from("same-origin-favicon-bytes");
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners, reload } = makeFaviconWebContents({
          url,
          title: "Same origin",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_same_origin");
        yield* manager.registerWebview("tab_favicon_same_origin", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [`${url}favicon.png`]);
        yield* settle(() => states.at(-1)?.faviconOrigin === new URL(url).origin);

        yield* manager.navigate("tab_favicon_same_origin", url);
        listeners.get("did-navigate")?.();
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success", 0);
        faviconUpdated?.({}, [`${url}favicon.png`]);
        yield* settle(() => fetch.mock.calls.length === 2 && states.at(-1)?.favicon !== undefined);

        expect(reload).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(states.at(-1)?.faviconOrigin).toBe(new URL(url).origin);
      }),
    ),
  );

  effectIt.effect("publishes a favicon received before did-navigate completes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5764";
        const faviconUrl = `${origin}/favicon.png`;
        const fetch = vi.fn(async () => {
          const bytes = Buffer.from("reloaded-favicon");
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners, setLoading } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Reload ordering",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reload_order");
        yield* manager.registerWebview("tab_favicon_reload_order", 42);

        setLoading(true);
        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-start-loading")?.();
        listeners.get("page-favicon-updated")?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 1);

        listeners.get("did-navigate")?.();
        yield* settle(() => states.at(-1)?.navStatus.kind === "Loading", 0);
        expect(states.at(-1)?.favicon).toBeUndefined();

        setLoading(false);
        listeners.get("did-stop-loading")?.();
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toBe(
          `data:image/png;base64,${Buffer.from("reloaded-favicon").toString("base64")}`,
        );
        expect(states.at(-1)?.faviconOrigin).toBe(origin);
      }),
    ),
  );

  effectIt.effect("keeps the current favicon when a reload emits no favicon event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5765";
        const favicon = Buffer.from("unchanged-reload-favicon");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            favicon.buffer.slice(favicon.byteOffset, favicon.byteOffset + favicon.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners, setLoading } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Reload without favicon event",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reload_without_event");
        yield* manager.registerWebview("tab_favicon_reload_without_event", 42);

        listeners.get("page-favicon-updated")?.({}, [`${origin}/favicon.png`]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.refresh("tab_favicon_reload_without_event");
        setLoading(true);
        listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: false });
        listeners.get("did-start-loading")?.();
        listeners.get("did-navigate")?.();
        expect(states.at(-1)?.navStatus.kind).toBe("Loading");
        setLoading(false);
        listeners.get("did-stop-loading")?.();
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success");

        expect(fetch).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon).toBe(`data:image/png;base64,${favicon.toString("base64")}`);
        expect(states.at(-1)?.faviconOrigin).toBe(origin);
      }),
    ),
  );

  effectIt.effect("rejects favicon captures invalidated before or started during navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5763";
        const oldUrl = `${origin}/old`;
        const nextUrl = `${origin}/next`;
        const bytes = Buffer.from("old-page-favicon");
        const oldFaviconUrl = `${origin}/old-favicon.png`;
        const loadingFaviconUrl = `${origin}/loading-favicon.png`;
        const pending = new Map<string, (response: unknown) => void>();
        let resolveDuringLoading = false;
        const fetch = vi.fn(
          (url: string, init?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              pending.set(url, resolve);
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
        const response = {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        };
        const { webContents, listeners } = makeFaviconWebContents({
          url: oldUrl,
          title: "Navigation race",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.gen(function* () {
            states.push(state);
            if (!resolveDuringLoading || state.navStatus.kind !== "Loading") return;
            resolveDuringLoading = false;
            listeners.get("page-favicon-updated")?.({}, [loadingFaviconUrl]);
            yield* settle(() => pending.has(loadingFaviconUrl), 0);
            pending.get(oldFaviconUrl)?.(response);
            pending.get(loadingFaviconUrl)?.(response);
          }),
        );
        yield* manager.createTab("tab_favicon_navigate_race");
        yield* manager.registerWebview("tab_favicon_navigate_race", 42);

        listeners.get("page-favicon-updated")?.({}, [oldFaviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 1, 0);
        const oldSignal = fetch.mock.calls[0]?.[1]?.signal;
        resolveDuringLoading = true;
        yield* manager.navigate("tab_favicon_navigate_race", nextUrl);
        yield* settle(() => false);

        expect(oldSignal?.aborted).toBe(true);
        expect(states.at(-1)?.navStatus).toMatchObject({ kind: "Loading", url: nextUrl });
        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(states.at(-1)?.faviconOrigin).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("recaptures a changed favicon after every refresh path", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5761";
        const faviconUrl = `${origin}/favicon.png`;
        const labels = [
          "initial-favicon",
          "refreshed-favicon",
          "hard-reloaded-favicon",
          "shortcut-refreshed-favicon",
        ];
        const fetch = vi.fn(async () => {
          const bytes = Buffer.from(labels[fetch.mock.calls.length - 1] ?? "unexpected");
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners, reload, reloadIgnoringCache } = makeFaviconWebContents({
          url: `${origin}/`,
          title: "Reload favicon",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reload");
        yield* manager.registerWebview("tab_favicon_reload", 42);
        const faviconUpdated = listeners.get("page-favicon-updated");

        faviconUpdated?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 1 && states.at(-1)?.favicon !== undefined);
        yield* manager.refresh("tab_favicon_reload");
        faviconUpdated?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 2);
        yield* manager.hardReload("tab_favicon_reload");
        faviconUpdated?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 3);
        const preventDefault = vi.fn();
        listeners.get("before-input-event")?.(
          { preventDefault },
          {
            type: "keyDown",
            key: "r",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          },
        );
        yield* settle(() => reload.mock.calls.length === 2);
        faviconUpdated?.({}, [faviconUrl]);
        yield* settle(() => fetch.mock.calls.length === 4);

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(reload).toHaveBeenCalledTimes(2);
        expect(reloadIgnoringCache).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon).toBe(
          `data:image/png;base64,${Buffer.from("shortcut-refreshed-favicon").toString("base64")}`,
        );
      }),
    ),
  );

  effectIt.effect("recaptures a favicon after an A to B to A revisit", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const siteA = "http://localhost:5750";
        const siteB = "http://localhost:5751";
        const fetch = vi.fn(async (faviconUrl: string) => {
          const bytes = Buffer.from(`favicon-bytes-for-${faviconUrl}`);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        });
        const { webContents, listeners, setUrl } = makeFaviconWebContents({
          url: `${siteA}/`,
          title: "Site A",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_revisit");
        yield* manager.registerWebview("tab_favicon_revisit", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [`${siteA}/favicon.png`]);
        yield* settle(() => states.at(-1)?.faviconOrigin === siteA);

        setUrl(`${siteB}/`);
        listeners.get("did-navigate")?.();
        yield* settle(() => {
          const navStatus = states.at(-1)?.navStatus;
          return navStatus?.kind === "Success" && navStatus.url === `${siteB}/`;
        }, 0);
        faviconUpdated?.({}, [`${siteB}/favicon.png`]);
        yield* settle(() => states.at(-1)?.faviconOrigin === siteB);

        setUrl(`${siteA}/`);
        listeners.get("did-navigate")?.();
        yield* settle(() => {
          const navStatus = states.at(-1)?.navStatus;
          return navStatus?.kind === "Success" && navStatus.url === `${siteA}/`;
        }, 0);
        faviconUpdated?.({}, [`${siteA}/favicon.png`]);
        yield* settle(
          () => fetch.mock.calls.length === 3 && states.at(-1)?.faviconOrigin === siteA,
        );

        faviconUpdated?.({}, [`${siteA}/favicon.png`]);
        yield* settle(() => fetch.mock.calls.length > 3);

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(states.at(-1)?.faviconOrigin).toBe(siteA);
      }),
    ),
  );

  effectIt.effect("ignores a favicon captured after its webview is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initial = Buffer.from("initial-favicon-bytes");
        const delayed = Buffer.from("delayed-favicon-bytes");
        let resolveFetch!: (response: unknown) => void;
        const response = (bytes: Buffer) => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        });
        const fetch = vi.fn((_url: string, _init?: { signal?: AbortSignal }) => {
          if (fetch.mock.calls.length === 1) return Promise.resolve(response(initial));
          return new Promise((resolve) => {
            resolveFetch = resolve;
          });
        });
        const oldWebview = makeFaviconWebContents({
          id: 42,
          url: "http://localhost:5752/",
          title: "Old",
          fetch,
        });
        const replacement = makeFaviconWebContents({
          id: 43,
          url: "http://localhost:5753/",
          title: "Replacement",
          fetch: vi.fn(),
        });
        fromId.mockImplementation((id) =>
          id === 42 ? oldWebview.webContents : replacement.webContents,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_swap");
        yield* manager.registerWebview("tab_favicon_swap", 42);
        oldWebview.listeners.get("page-favicon-updated")?.(null, [
          "http://localhost:5752/favicon.png",
        ]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);
        oldWebview.listeners.get("page-favicon-updated")?.(null, [
          "http://localhost:5752/favicon-next.png",
        ]);
        yield* settle(() => fetch.mock.calls.length === 2, 0);
        const detachedSignal = fetch.mock.calls[1]?.[1]?.signal;

        yield* manager.registerWebview("tab_favicon_swap", 43);
        expect(detachedSignal?.aborted).toBe(true);
        oldWebview.setUrl("http://localhost:5752/late-navigation");
        oldWebview.listeners.get("did-navigate")?.();
        oldWebview.listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "http://localhost:5752/late-navigation",
          true,
        );
        yield* settle(() => false);
        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(states.at(-1)?.navStatus.kind).toBe("Success");
        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(states.at(-1)?.faviconOrigin).toBeUndefined();
        oldWebview.listeners.get("before-input-event")?.(
          { preventDefault: vi.fn() },
          {
            type: "keyDown",
            key: "r",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          },
        );
        yield* settle(() => false);
        expect(oldWebview.reload).not.toHaveBeenCalled();
        expect(replacement.reload).not.toHaveBeenCalled();
        resolveFetch(response(delayed));
        yield* settle(() => false);

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("recaptures when a detached webContents id is reused", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const origin = "http://localhost:5759";
        const faviconUrl = `${origin}/favicon.png`;
        const response = (label: string) => {
          const bytes = Buffer.from(label);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
          };
        };
        const firstFetch = vi.fn(async () => response("first-webview-favicon"));
        const reusedFetch = vi.fn(async () => response("reused-webview-favicon"));
        const first = makeFaviconWebContents({
          id: 42,
          url: `${origin}/`,
          title: "First",
          fetch: firstFetch,
        });
        const replacement = makeFaviconWebContents({
          id: 43,
          url: "http://localhost:5760/",
          title: "Replacement",
          fetch: vi.fn(),
        });
        const reused = makeFaviconWebContents({
          id: 42,
          url: `${origin}/`,
          title: "Reused",
          fetch: reusedFetch,
        });
        let webContents42 = first.webContents;
        fromId.mockImplementation((id) =>
          id === 42 ? webContents42 : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        first.listeners.get("page-favicon-updated")?.({}, [faviconUrl]);
        yield* settle(
          () => firstFetch.mock.calls.length === 1 && states.at(-1)?.favicon !== undefined,
        );

        yield* manager.registerWebview("tab_favicon_reused_id", 43);
        webContents42 = reused.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        reused.listeners.get("page-favicon-updated")?.({}, [faviconUrl]);
        yield* settle(() => reusedFetch.mock.calls.length === 1);

        expect(reusedFetch).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon).toBe(
          `data:image/png;base64,${Buffer.from("reused-webview-favicon").toString("base64")}`,
        );
      }),
    ),
  );

  effectIt.effect("does not publish or dedupe an undecodable favicon buffer", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        createFromBuffer.mockReturnValueOnce({
          getSize: () => ({ width: 0, height: 0 }),
          isEmpty: () => true,
          toDataURL: () => "data:image/png;base64,",
          resize: () => ({ toDataURL: () => "data:image/png;base64," }),
        });
        const url = "http://localhost:5736/";
        const corrupt = Buffer.from("corrupt-image-data");
        const fetch = vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            corrupt.buffer.slice(corrupt.byteOffset, corrupt.byteOffset + corrupt.byteLength),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        const { webContents, listeners } = makeFaviconWebContents({
          url,
          title: "localhost:5736",
          fetch,
        });
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_undecodable");
        yield* manager.registerWebview("tab_favicon_undecodable", 42);

        listeners.get("page-favicon-updated")?.({}, ["http://localhost:5736/favicon.png"]);

        yield* settle(() => fetch.mock.calls.length > 0);

        expect(fetch).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon).toBeUndefined();

        createFromBuffer.mockReturnValueOnce({
          getSize: () => ({ width: 16, height: 16 }),
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,VALID",
          resize: () => ({ toDataURL: () => "data:image/png;base64,VALID" }),
        });
        const validBuffer = Buffer.from("valid-image-data--");
        fetch.mockImplementation(async () => ({
          ok: true,
          arrayBuffer: async () =>
            validBuffer.buffer.slice(
              validBuffer.byteOffset,
              validBuffer.byteOffset + validBuffer.byteLength,
            ),
          headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        }));
        listeners.get("page-favicon-updated")?.({}, ["http://localhost:5736/favicon.png"]);

        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,VALID");
      }),
    ),
  );

  effectIt.effect("validates opaque favicon responses before publishing them", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        createFromBuffer
          .mockReturnValueOnce({
            getSize: () => ({ width: 0, height: 0 }),
            isEmpty: () => true,
            toDataURL: () => "data:image/png;base64,",
            resize: () => ({ toDataURL: () => "data:image/png;base64," }),
          })
          .mockReturnValueOnce({
            getSize: () => ({ width: 0, height: 0 }),
            isEmpty: () => true,
            toDataURL: () => "data:image/png;base64,",
            resize: () => ({ toDataURL: () => "data:image/png;base64," }),
          })
          .mockReturnValueOnce({
            getSize: () => ({ width: 0, height: 0 }),
            isEmpty: () => true,
            toDataURL: () => "data:image/png;base64,",
            resize: () => ({ toDataURL: () => "data:image/png;base64," }),
          })
          .mockReturnValueOnce({
            getSize: () => ({ width: 64, height: 64 }),
            isEmpty: () => false,
            toDataURL: () => `data:image/png;base64,${"A".repeat(8_192)}`,
            resize: () => ({ toDataURL: () => "data:image/png;base64,RESIZED" }),
          });
        const origin = "http://localhost:5761";
        const svgUrl = `${origin}/broken.svg`;
        const icoUrl = `${origin}/broken.ico`;
        const validIcoUrl = `${origin}/valid.ico`;
        const validSvgUrl = `${origin}/valid.svg`;
        const undecodableSvgUrl = `${origin}/undecodable.svg`;
        const oversizedSvgUrl = `${origin}/oversized.svg`;
        const mislabeledIcoUrl = `${origin}/mislabeled.ico`;
        const icoPayload = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        );
        const validIco = Buffer.alloc(22 + icoPayload.byteLength);
        validIco.writeUInt16LE(1, 2);
        validIco.writeUInt16LE(1, 4);
        validIco[6] = 1;
        validIco[7] = 1;
        validIco.writeUInt16LE(1, 10);
        validIco.writeUInt16LE(32, 12);
        validIco.writeUInt32LE(icoPayload.byteLength, 14);
        validIco.writeUInt32LE(22, 18);
        icoPayload.copy(validIco, 22);
        const validSvg = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
        );
        const undecodableSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0"');
        const oversizedSvg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><desc>${"x".repeat(7_000)}</desc><rect width="32" height="16"/></svg>`,
        );
        const fetch = vi.fn(async (url: string) => {
          const [mime, bytes] =
            url === svgUrl
              ? (["image/svg+xml", Buffer.from("<svg ")] as const)
              : url === icoUrl
                ? (["image/x-icon", Buffer.from([0, 0, 1, 0])] as const)
                : url === validIcoUrl
                  ? (["image/x-icon", validIco] as const)
                  : url === validSvgUrl
                    ? (["image/svg+xml", validSvg] as const)
                    : url === undecodableSvgUrl
                      ? (["image/svg+xml", undecodableSvg] as const)
                      : url === oversizedSvgUrl
                        ? (["image/svg+xml", oversizedSvg] as const)
                        : (["image/x-icon", Buffer.from("decoded-mime-mismatch")] as const);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            headers: { get: (name: string) => (name === "content-type" ? mime : null) },
          };
        });
        const { webContents, listeners, executeJavaScriptInIsolatedWorld } = makeFaviconWebContents(
          {
            url: `${origin}/`,
            title: "localhost:5761",
            fetch,
            rasterizedFavicon: (code) =>
              [validIco, validSvg, oversizedSvg].some((bytes) =>
                code.includes(bytes.toString("base64")),
              )
                ? "data:image/png;base64,RASTERIZED"
                : null,
          },
        );
        fromId.mockReturnValue(webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_malformed_opaque");
        yield* manager.registerWebview("tab_favicon_malformed_opaque", 42);

        const faviconUpdated = listeners.get("page-favicon-updated");
        faviconUpdated?.({}, [undecodableSvgUrl]);
        yield* settle(() => executeJavaScriptInIsolatedWorld.mock.calls.length === 1);
        expect(states.at(-1)?.favicon).toBeUndefined();

        faviconUpdated?.({}, [svgUrl, icoUrl, validIcoUrl]);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(fetch).toHaveBeenCalledTimes(4);
        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,RASTERIZED");
        expect(executeJavaScriptInIsolatedWorld).toHaveBeenNthCalledWith(4, 1001, [
          { code: expect.stringContaining(validIco.toString("base64")) },
        ]);

        faviconUpdated?.({}, [validSvgUrl]);
        yield* settle(() => fetch.mock.calls.length === 5);

        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,RASTERIZED");
        expect(executeJavaScriptInIsolatedWorld).toHaveBeenNthCalledWith(5, 1001, [
          { code: expect.stringContaining(validSvg.toString("base64")) },
        ]);

        faviconUpdated?.({}, [mislabeledIcoUrl]);
        yield* settle(() => fetch.mock.calls.length === 6);

        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,RESIZED");

        faviconUpdated?.({}, [oversizedSvgUrl]);
        yield* settle(() => fetch.mock.calls.length === 7);

        expect(fetch).toHaveBeenCalledTimes(7);
        expect(states.at(-1)?.favicon).toBe("data:image/png;base64,RASTERIZED");
        expect(executeJavaScriptInIsolatedWorld).toHaveBeenNthCalledWith(7, 1001, [
          { code: expect.stringContaining(oversizedSvg.toString("base64")) },
        ]);
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
        capturePage.mockRejectedValueOnce(captureCause);
        const exit = yield* Effect.exit(manager.captureScreenshot("tab_1"));
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

  effectIt.effect("captures hidden preview recordings independently for concurrent tabs", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
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
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);
        yield* Effect.all([manager.startRecording("tab_1"), manager.startRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(2);
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              tabId: "tab_1",
              data: firstJpeg.toString("base64"),
              width: 800,
              height: 600,
            }),
            expect.objectContaining({
              tabId: "tab_2",
              data: secondJpeg.toString("base64"),
              width: 390,
              height: 844,
            }),
          ]),
        );
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("drops a captured frame when the tab webview changes during capture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const staleImage: TestCapturedPreviewImage = {
          toJPEG: vi.fn(() => Buffer.from("stale-recording-frame")),
          getSize: vi.fn(() => ({ width: 1280, height: 720 })),
        };
        let markCaptureStarted!: () => void;
        const captureStarted = new Promise<void>((resolve) => {
          markCaptureStarted = resolve;
        });
        let resolveCapture: ((image: TestCapturedPreviewImage) => void) | undefined;
        const staleCapturePage = vi.fn(() => {
          markCaptureStarted();
          return new Promise<TestCapturedPreviewImage>((resolve) => {
            resolveCapture = resolve;
          });
        });
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(staleCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_capture_replaced");
        yield* manager.registerWebview("tab_capture_replaced", 42);
        const recordingFiber = yield* manager
          .startRecording("tab_capture_replaced")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => captureStarted);

        yield* manager.registerWebview("tab_capture_replaced", 43);
        resolveCapture?.(staleImage);
        yield* Fiber.join(recordingFiber);

        expect(staleImage.getSize).not.toHaveBeenCalled();
        expect(staleImage.toJPEG).not.toHaveBeenCalled();
        expect(frames).toHaveLength(0);
        expect(replacementCapturePage).not.toHaveBeenCalled();

        yield* manager.stopRecording("tab_capture_replaced");
      }),
    ),
  );

  effectIt.effect("keeps an in-flight frame when a capture consumer is added", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image: TestCapturedPreviewImage = {
          toJPEG: vi.fn(() => Buffer.from("shared-in-flight-frame")),
          getSize: vi.fn(() => ({ width: 1280, height: 720 })),
        };
        let markCaptureStarted!: () => void;
        const captureStarted = new Promise<void>((resolve) => {
          markCaptureStarted = resolve;
        });
        let resolveCapture: ((captured: TestCapturedPreviewImage) => void) | undefined;
        const capturePage = vi.fn(() => {
          markCaptureStarted();
          return new Promise<TestCapturedPreviewImage>((resolve) => {
            resolveCapture = resolve;
          });
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );

        yield* manager.createTab("tab_capture_consumer_added");
        yield* manager.registerWebview("tab_capture_consumer_added", 42);
        const recordingFiber = yield* manager
          .startRecording("tab_capture_consumer_added")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => captureStarted);

        yield* manager.openPictureInPicture("tab_capture_consumer_added");
        resolveCapture?.(image);
        yield* Fiber.join(recordingFiber);

        expect(recordingFrames).toHaveLength(1);
        expect(send).toHaveBeenCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({
            tabId: "tab_capture_consumer_added",
            data: Buffer.from("shared-in-flight-frame").toString("base64"),
          }),
        );

        yield* manager.stopRecording("tab_capture_consumer_added");
        yield* manager.closePictureInPicture("tab_capture_consumer_added");
      }),
    ),
  );

  effectIt.effect("emits debugger screencast frames only while recording is active", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let debuggerMessage:
          | ((event: unknown, method: string, params: Record<string, unknown>) => void)
          | undefined;
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("scheduled-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { result: { value: null } } : undefined,
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
            on: vi.fn(
              (
                event: string,
                listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
              ) => {
                if (event === "message") debuggerMessage = listener;
              },
            ),
            off: vi.fn(),
          },
          capturePage,
        } as never);
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );
        yield* manager.createTab("tab_screencast_guard");
        yield* manager.registerWebview("tab_screencast_guard", 42);
        yield* manager.automationEvaluate("tab_screencast_guard", { expression: "null" });

        debuggerMessage?.({}, "Page.screencastFrame", {
          sessionId: 1,
          data: "inactive-frame",
          metadata: { deviceWidth: 1280, deviceHeight: 720 },
        });
        yield* Effect.yieldNow;
        expect(recordingFrames).toHaveLength(0);

        yield* manager.startRecording("tab_screencast_guard");
        recordingFrames.length = 0;
        debuggerMessage?.({}, "Page.screencastFrame", {
          sessionId: 2,
          data: "active-frame",
          metadata: { deviceWidth: 1280, deviceHeight: 720 },
        });
        yield* Effect.yieldNow;

        expect(recordingFrames).toEqual([
          expect.objectContaining({
            tabId: "tab_screencast_guard",
            data: "active-frame",
            width: 1280,
            height: 720,
          }),
        ]);
        yield* manager.stopRecording("tab_screencast_guard");
      }),
    ),
  );

  effectIt.effect("shares background frame capture between recording and picture-in-picture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("shared-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
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
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        const pictureInPictureListeners = new Map<string, () => void>();
        const pictureInPictureSend = vi.fn();
        const pictureInPictureWindow = {
          isDestroyed: vi.fn(() => false),
          once: vi.fn((event: string, listener: () => void) => {
            pictureInPictureListeners.set(event, listener);
          }),
          setAlwaysOnTop: vi.fn(),
          setVisibleOnAllWorkspaces: vi.fn(),
          setAspectRatio: vi.fn(),
          getContentSize: vi.fn(() => [480, 320] as [number, number]),
          setContentSize: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            pictureInPictureListeners.get("closed")?.();
          }),
          webContents: {
            send: pictureInPictureSend,
          },
        };
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );
        yield* manager.createTab("tab_pip");
        yield* manager.registerWebview("tab_pip", 42);
        yield* manager.openPictureInPicture("tab_pip");

        expect(browserWindowConstructor).toHaveBeenCalledWith(
          expect.objectContaining({
            alwaysOnTop: true,
            show: false,
            skipTaskbar: true,
            webPreferences: expect.objectContaining({
              preload: "/tmp/t3/desktop/preview-pip-preload.cjs",
              backgroundThrottling: false,
            }),
          }),
        );
        expect(pictureInPictureWindow.showInactive).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(pictureInPictureWindow.setContentSize).toHaveBeenCalledWith(523, 294, false);
        expect(pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0] ?? 0,
        );
        expect(pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[1] ?? 0,
        );
        expect(pictureInPictureSend).toHaveBeenCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({
            tabId: "tab_pip",
            data: jpeg.toString("base64"),
            width: 1280,
            height: 720,
          }),
        );
        expect(states.at(-1)?.pictureInPicture).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();

        yield* manager.startRecording("tab_pip");
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recordingFrames).toHaveLength(0);

        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(recordingFrames).toHaveLength(1);

        yield* manager.stopRecording("tab_pip");
        const framesBeforePictureInPictureOnlyTick = pictureInPictureSend.mock.calls.length;
        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(3);
        expect(pictureInPictureSend.mock.calls.length).toBeGreaterThan(
          framesBeforePictureInPictureOnlyTick,
        );
        expect(recordingFrames).toHaveLength(1);

        yield* manager.closePictureInPicture("tab_pip");
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("retries a cold hidden-tab capture without dropping recording", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("recovered-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_cold_capture");
        yield* manager.registerWebview("tab_cold_capture", 42);

        yield* manager.startRecording("tab_cold_capture");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(0);

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(frames).toEqual([
          expect.objectContaining({
            tabId: "tab_cold_capture",
            data: jpeg.toString("base64"),
            width: 1280,
            height: 720,
          }),
        ]);

        yield* manager.stopRecording("tab_cold_capture");
      }),
    ),
  );

  effectIt.effect("drops empty frames before picture-in-picture delivery", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const validImage: TestCapturedPreviewImage = {
          toJPEG: () => Buffer.from("valid-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(async () => validImage);
        capturePage.mockResolvedValueOnce({
          toJPEG: () => Buffer.from("empty-preview-frame"),
          getSize: () => ({ width: 0, height: 0 }),
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_empty_frame");
        yield* manager.registerWebview("tab_empty_frame", 42);
        yield* manager.openPictureInPicture("tab_empty_frame");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setAspectRatio).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();

        yield* TestClock.adjust(100);

        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_empty_frame");
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>(() => {
              // Simulate a renderer load that never settles.
            }),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* settle(() => pictureInPictureWindow.loadURL.mock.calls.length === 1, 0);
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );

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
