import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { vi, type Mock } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

/** Mock instances leak vitest's internal `Procedure` name, so name the shape once. */
export type TestMock = Mock<(...args: never[]) => unknown>;

export interface ManagerTestMocks {
  readonly previewSession: { readonly on: ReturnType<typeof vi.fn> };
  readonly mkdir: ReturnType<typeof vi.fn<(path: string) => undefined>>;
  readonly writeFile: ReturnType<typeof vi.fn<(path: string, data: Uint8Array) => undefined>>;
  readonly fromId: ReturnType<typeof vi.fn<(id?: number) => Electron.WebContents | null>>;
  readonly webviewSend: ReturnType<typeof vi.fn>;
}

export interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

export type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

export interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

export type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

export const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

export const TEST_FAVICON = "data:image/png;base64,cG5n";

export const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
export const makeChangeSignal = () => {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const wake of waiters) wake();
    },
    until: (predicate: () => boolean) =>
      Effect.callback<void>((resume) => {
        if (predicate()) return resume(Effect.void);
        const wake = () => {
          if (!predicate()) return;
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => void waiters.delete(wake));
      }),
  };
};
export type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
export const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

export interface TestPictureInPictureHelper {
  readonly pictureInPictureWindow: {
    readonly isDestroyed: TestMock;
    readonly once: TestMock;
    readonly setAlwaysOnTop: TestMock;
    readonly setVisibleOnAllWorkspaces: TestMock;
    readonly setAspectRatio: TestMock;
    readonly getContentSize: TestMock;
    readonly setContentSize: TestMock;
    readonly loadURL: TestMock;
    readonly showInactive: TestMock;
    readonly close: TestMock;
    readonly webContents: {
      readonly on: TestMock;
      readonly off: TestMock;
      readonly send: TestMock;
    };
  };
  readonly send: TestMock;
  readonly webContentsListeners: Map<string, () => void>;
}

export const makeTestPictureInPictureWindow = (
  loadURL: () => Promise<void> = async () => undefined,
): TestPictureInPictureHelper => {
  const listeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const webContents = {
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
    send,
  };
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
    get webContents() {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
      return webContents;
    },
  };
  return { pictureInPictureWindow, send, webContentsListeners };
};

export interface TestFaviconWebContentsHelper {
  readonly executeJavaScriptInIsolatedWorld: TestMock;
  readonly fetch: TestMock;
  readonly debuggerOff: TestMock;
  readonly listeners: Map<string, (...args: never[]) => void>;
  readonly loadURL: TestMock;
  readonly off: TestMock;
  readonly reload: TestMock;
  readonly setDestroyed: (value: boolean) => void;
  readonly setLoading: (value: boolean) => void;
  readonly setUrl: (url: string) => void;
  readonly webContents: never;
}

const layerEnvironment = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

export const buildManagerLayer = (
  mocks: ManagerTestMocks,
  platform: NodeJS.Platform = "darwin",
) => {
  const layerBrowserSession = Layer.succeed(
    BrowserSession.BrowserSession,
    BrowserSession.BrowserSession.of({
      getPartition: () => Effect.succeed("persist:t3code-preview-test"),
      isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
      getSession: () => Effect.succeed(mocks.previewSession as unknown as Electron.Session),
      clearCookies: () => Effect.void,
      clearCache: () => Effect.void,
    }),
  );

  const layerFileSystem = FileSystem.layerNoop({
    makeDirectory: (path) =>
      Effect.sync(() => {
        mocks.mkdir(path);
      }),
    writeFile: (path, data) =>
      Effect.sync(() => {
        mocks.writeFile(path, data);
      }),
  });

  return PreviewManager.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
    ),
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(layerBrowserSession),
    Layer.provideMerge(
      Layer.mock(PreviewPasskeys.PreviewPasskeys)({
        bridgeEnabled: false,
        installSessionHandlers: () => {},
        attachGuest: () => () => {},
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(layerFileSystem),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, platform)),
  );
};

export type ManagerTestLayer = ReturnType<typeof buildManagerLayer>;

export function createManagerHarness(mocks: ManagerTestMocks) {
  const managerLayer = (platform: NodeJS.Platform = "darwin"): ManagerTestLayer =>
    buildManagerLayer(mocks, platform);


  const withManager = <A, E, R>(
    use: (manager: PreviewManager.PreviewManager["Service"]) => Effect.Effect<A, E, R>,
    platform: NodeJS.Platform = "darwin",
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      return yield* use(manager);
    }).pipe(Effect.provide(managerLayer(platform)), Effect.scoped);

  const makeTestPreviewWebContents = (
    capturePage: () => Promise<TestCapturedPreviewImage>,
    id = 42,
    hostWebContents: TestHostWebContents = makeTestHostWebContents(),
  ) => {
    const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
    return {
      id,
      mainFrame: { routingId: id },
      hostWebContents,
      executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoadingMainFrame: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      setBackgroundThrottling,
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      ipc: { on: vi.fn(), off: vi.fn() },
      send: mocks.webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
      },
      capturePage,
    } as unknown as TestPreviewWebContents;
  };

  const setupRecordingRaceTabs = (manager: PreviewManager.PreviewManager["Service"]) =>
    Effect.gen(function* () {
      const capturePage = vi.fn(async () => ({
        toJPEG: () => Buffer.from("unused-recording-frame"),
        getSize: () => ({ width: 1280, height: 720 }),
      }));
      const host = makeTestHostWebContents();
      const destroyedIds = new Set<number>();
      const makeWebContents = (id: number) =>
        Object.assign(makeTestPreviewWebContents(capturePage, id, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
          isDestroyed: () => destroyedIds.has(id),
        });
      const webContentsById = new Map([
        [41, makeWebContents(41)],
        [42, makeWebContents(42)],
      ]);
      mocks.fromId.mockImplementation((id) =>
        id === undefined ? null : (webContentsById.get(id) ?? null),
      );
      yield* manager.createTab("tab_race_a");
      yield* manager.createTab("tab_race_b");
      yield* manager.registerWebview("tab_race_a", 41);
      yield* manager.registerWebview("tab_race_b", 42);
      const grants: Array<{ video?: unknown }> = [];
      return {
        host,
        grants,
        destroy: (id: number) => destroyedIds.add(id),
        takeGrant: (frame = host.mainFrame) =>
          host.displayMediaHandler()?.({ frame }, (value) => {
            grants.push(value);
          }),
      };
    });

  const makeFaviconWebContents = (options?: {
    readonly changes?: ChangeSignal;
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly id?: number;
    readonly rasterize?: (code: string) => Promise<unknown>;
    readonly url?: string;
  }): TestFaviconWebContentsHelper => {
    const sourcePng = makeSourcePng();
    const listeners = new Map<string, (...args: never[]) => void>();
    let currentUrl = options?.url ?? "http://localhost:3200/";
    let destroyed = false;
    let loading = false;
    const fetchImpl =
      options?.fetch ??
      (async () =>
        new Response(new Uint8Array(sourcePng), {
          headers: { "content-type": "image/png" },
        }));
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const response = fetchImpl(url, init);
      options?.changes?.notify();
      return response;
    });
    const executeJavaScriptInIsolatedWorld = vi.fn(
      (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) => {
        const result = options?.rasterize
          ? options.rasterize(scripts[0]?.code ?? "")
          : Promise.resolve(TEST_FAVICON);
        options?.changes?.notify();
        return result;
      },
    );
    const reload = vi.fn();
    const loadURL = vi.fn(async (url: string) => {
      currentUrl = url;
    });
    const off = vi.fn();
    const debuggerOff = vi.fn();
    const webContents = {
      id: options?.id ?? 42,
      isDestroyed: () => destroyed,
      getType: () => "webview",
      getURL: () => currentUrl,
      getTitle: () => "Preview",
      isLoadingMainFrame: () => loading,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      reload,
      reloadIgnoringCache: vi.fn(),
      loadURL,
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      off,
      ipc: { on: vi.fn(), off: vi.fn() },
      send: mocks.webviewSend,
      session: { fetch },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isFocused: vi.fn(() => true),
      focusedFrame: {} as object | null,
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScriptInIsolatedWorld,
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: debuggerOff,
      },
    };
    return {
      executeJavaScriptInIsolatedWorld,
      fetch,
      debuggerOff,
      listeners,
      loadURL,
      off,
      reload,
      setDestroyed: (value: boolean) => {
        destroyed = value;
      },
      setLoading: (value: boolean) => {
        loading = value;
      },
      setUrl: (url: string) => {
        currentUrl = url;
      },
      webContents: webContents as never,
    };
  };

  return {
    managerLayer,
    withManager,
    makeTestPreviewWebContents,
    setupRecordingRaceTabs,
    makeFaviconWebContents,
  };
}
