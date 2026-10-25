import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  DesktopPreviewRecordingInputEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("keeps a form POST with a body on the in-place path", () => {
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("navigate");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "not a url",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("navigate");
    }
  });

  it("denies a blank window instead of blanking the opener", () => {
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });
});

const {
  browserWindowConstructor,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  previewSession,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      clipboardItemConstructor(data);
    }
  },
  clipboard: {
    write: writeClipboard,
  },
  nativeImage: {
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

const layerBrowserSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.succeed(previewSession as unknown as Electron.Session),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

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

const layerFileSystem = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const managerLayer = (platform: NodeJS.Platform = "darwin") =>
  PreviewManager.layer.pipe(
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

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  platform: NodeJS.Platform = "darwin",
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(managerLayer(platform)), Effect.scoped);

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

const makeTestHostWebContents = (): TestHostWebContents => {
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
    send: webviewSend,
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
    fromId.mockImplementation((id) =>
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

const TEST_FAVICON = "data:image/png;base64,cG5n";

const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const makeFaviconWebContents = (options?: {
  readonly changes?: ChangeSignal;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly id?: number;
  readonly rasterize?: (code: string) => Promise<unknown>;
  readonly url?: string;
}) => {
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
    send: webviewSend,
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

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
const makeChangeSignal = () => {
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
type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
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

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    previewSession.on.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    clipboardItemConstructor.mockClear();
    writeClipboard.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect.each([
    ["linux", "ctrl+alt+[", "[", "BracketLeft", false],
    ["win32", "ctrl+alt+8", "[", "Digit8", false],
    ["win32", "ctrl+alt+k", "K", "KeyK", false],
    ["linux", "ctrl+alt+`", "Dead", "Backquote", false],
    ["darwin", "ctrl+alt+[", "[", "BracketLeft", true],
    ["linux", "ctrl+alt+f7", "F7", "F7", true],
  ] as const)(
    "handles ambiguous preview chords on %s: %s",
    ([platform, chord, key, code, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            const send = vi.fn();
            Object.assign(preview.webContents, {
              hostWebContents: { isDestroyed: () => false, send },
            });
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_alt_graph");
            yield* manager.registerWebview("tab_alt_graph", 42);
            yield* manager.setForwardedShortcuts([
              { command: "view.reopenClosed", shortcut: parseKeybindingShortcut(chord)! },
            ]);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              {
                type: "keyDown",
                key,
                code,
                meta: false,
                control: true,
                shift: false,
                alt: true,
              } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect("keeps editing and forwarded shortcuts in whichever tab holds focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const send = vi.fn();
        const host = { isDestroyed: () => false, send };
        const older = makeFaviconWebContents({ id: 42 });
        const newer = makeFaviconWebContents({ id: 43 });
        for (const tab of [older, newer]) Object.assign(tab.webContents, { hostWebContents: host });
        getFocusedWebContents.mockReturnValue(newer.webContents as never);
        fromId.mockReturnValue(older.webContents);
        yield* manager.createTab("tab_older");
        yield* manager.registerWebview("tab_older", 42);
        fromId.mockReturnValue(newer.webContents);
        yield* manager.createTab("tab_newer");
        yield* manager.registerWebview("tab_newer", 43);
        const shortcut = parseKeybindingShortcut("mod+shift+t")!;
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        const beforeInput = older.listeners.get("before-input-event")!;
        const key = { type: "keyDown", meta: true, control: false, alt: false };
        beforeInput(
          { preventDefault: vi.fn() } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (older.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(false);

        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, { ...key, key: "T", shift: true } as never);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", "view.reopenClosed");

        Object.assign(newer.webContents, { focusedFrame: null });
        const agentInput = newer.listeners.get("before-input-event")!;
        const agentPreventDefault = vi.fn();
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (newer.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(true);
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "T", shift: true } as never,
        );
        expect(agentPreventDefault).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledOnce();
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
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
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
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

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
          isLoadingMainFrame: () => false,
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
          setIgnoreMenuShortcuts: vi.fn(),
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

  effectIt.effect("does not let destroyed-webview cleanup detach a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const previous = makeFaviconWebContents();
        const replacement = makeFaviconWebContents({ url: "https://example.com/" });
        let current = previous.webContents;
        let startReplacementRegistration: () => void = () => void 0;
        const replacementReady = new Promise<void>((resolve) => {
          startReplacementRegistration = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* manager.createTab("tab_destroyed_replacement_race");
        yield* manager.registerWebview("tab_destroyed_replacement_race", 42);
        yield* manager.setColorScheme("tab_destroyed_replacement_race", "dark");
        const replacementRegistration = yield* Effect.promise(() => replacementReady).pipe(
          Effect.flatMap(() => manager.registerWebview("tab_destroyed_replacement_race", 42)),
          Effect.forkChild({ startImmediately: true }),
        );
        previous.setDestroyed(true);
        previous.debuggerOff.mockImplementationOnce(() => {
          current = replacement.webContents;
          startReplacementRegistration();
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.navigate("tab_destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(replacementRegistration);

        expect(Exit.isSuccess(registrationExit)).toBe(true);
        expect(previous.off).toHaveBeenCalled();
        expect(replacement.off).not.toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
          changes,
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
          changes,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          changes,
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ changes, id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        const initial = makeFaviconWebContents({ changes, id: 42 });
        const replacement = makeFaviconWebContents({ changes, id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  const makeAttachingGuest = (id: number) => {
    const listeners = new Map<string, () => void>();
    const attach = vi.fn();
    const detach = vi.fn();
    const sendCommand = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const detachListeners = new Set<() => void>();
    let chromiumDetaches = 0;
    let destroyed = false;
    const wc = {
      id,
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return false;
      },
      getType: () => "webview",
      getURL: () => "http://localhost:5173/README.md",
      getTitle: () => "README.md",
      isLoadingMainFrame: () => true,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => attach.mock.calls.length > detach.mock.calls.length + chromiumDetaches,
        attach,
        detach,
        sendCommand,
        on: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.delete(listener);
        },
      },
    };
    /** Chromium dropping the debugger without a detach() call. */
    const chromiumDetach = () => {
      chromiumDetaches += 1;
      // Snapshot like an EventEmitter, so a listener added during emit waits for the next one.
      for (const listener of Array.from(detachListeners)) listener();
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      attach,
      detach,
      sendCommand,
      chromiumDetach,
      destroy: () => {
        destroyed = true;
        listeners.get("destroyed")?.();
      },
    };
  };

  effectIt.effect("reattaches a debugger that Chromium dropped on its own", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAttachingGuest(48);
        fromId.mockReturnValue(guest.wc);
        yield* manager.createTab("tab_detached");
        yield* manager.registerWebview("tab_detached", 48);
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(1);

        guest.chromiumDetach();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("skips a guest destroyed while another guest's session opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const slow = makeAttachingGuest(46);
        let releaseSlow = () => {};
        const slowCommand = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slow.sendCommand.mockImplementation(() => slowCommand);
        const queued = makeAttachingGuest(47);

        const slowFiber = yield* manager
          .prepareWebview(slow.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queuedFiber = yield* manager
          .prepareWebview(queued.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        queued.destroy();
        releaseSlow();

        expect(Exit.isSuccess(yield* Fiber.await(slowFiber))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.await(queuedFiber))).toBe(true);
        expect(slow.attach).toHaveBeenCalledTimes(1);
        expect(queued.attach).not.toHaveBeenCalled();
      }),
    ),
  );

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;
    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /** Simulate playback starting during attach before the tab owns the guest and can receive its events. */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;
          if (audibleAfterFirstRead && audibleReads > 1) return true;
          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        send: webviewSend,
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
      } as never,
    };
  };

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
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

        for (const exit of [registrationExit, recordingExit] as ReadonlyArray<
          Exit.Exit<unknown, PreviewManager.PreviewManagerError>
        >) {
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

  effectIt.effect("preserves both screenshots of the same site in the same millisecond", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstPng = Buffer.from("first-preview-png");
        const secondPng = Buffer.from("second-preview-png");
        const pngImage = (png: Buffer) => ({
          toPNG: () => png,
          toJPEG: () => png,
          getSize: () => ({ width: 1280, height: 720 }),
        });
        const capturePage = vi
          .fn<() => Promise<ReturnType<typeof pngImage>>>()
          .mockResolvedValueOnce(pngImage(firstPng))
          .mockResolvedValueOnce(pngImage(secondPng));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const first = yield* manager.captureScreenshot("tab_1");
        const second = yield* manager.captureScreenshot("tab_1");

        expect(first.createdAt).toBe(second.createdAt);
        expect(first.id).not.toBe(second.id);
        expect(first.path).not.toBe(second.path);
        expect(first.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(second.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(writeFile.mock.calls).toEqual([
          [first.path, firstPng],
          [second.path, secondPng],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps every recorded guest unthrottled until its frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const firstWebContents = makeTestPreviewWebContents(capturePage, 41, host);
        const secondWebContents = makeTestPreviewWebContents(capturePage, 42, host);
        const webContentsById = new Map([
          [41, firstWebContents],
          [42, secondWebContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_capture_throttling_1");
        yield* manager.createTab("tab_capture_throttling_2");
        yield* manager.registerWebview("tab_capture_throttling_1", 41);
        yield* manager.registerWebview("tab_capture_throttling_2", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        yield* manager.startRecording("tab_capture_throttling_1");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not commit failed starts and retries throttle restoration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_throttling_failure");
        yield* manager.registerWebview("tab_capture_throttling_failure", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_capture_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);

        yield* manager.startRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.startRecording("tab_capture_throttling_failure");
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps frame capture closed when a replacement is destroyed during cleanup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windowEvents = new Map<string, () => void>();
        const host = makeTestHostWebContents();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        yield* manager.createTab("tab_shutdown");
        yield* manager.registerWebview("tab_shutdown", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: (event: string, listener: () => void) => windowEvents.set(event, listener),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);
        yield* manager.startRecording("tab_shutdown");
        const pip = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pip.pictureInPictureWindow;
        });
        yield* manager.openPictureInPicture("tab_shutdown");
        const capturesBeforeClose = capturePage.mock.calls.length;
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          state.pictureInPicture
            ? Effect.void
            : Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
        );

        windowEvents.get("closed")!();
        yield* Deferred.await(cleanupStarted);
        let destroyed = false;
        const replacement = yield* manager
          .setMainWindow({
            isDestroyed: () => destroyed,
            once: vi.fn(),
            webContents: { setBackgroundThrottling: vi.fn() },
          } as never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        try {
          expect(replacement.pollUnsafe()).toBeUndefined();
          destroyed = true;
        } finally {
          yield* Deferred.succeed(releaseCleanup, undefined);
        }
        yield* Fiber.join(replacement);

        const restart = yield* Effect.exit(manager.startRecording("tab_shutdown"));
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(restart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_shutdown",
          });
        }
        expect(capturePage).toHaveBeenCalledTimes(capturesBeforeClose);
        expect(pip.pictureInPictureWindow.isDestroyed()).toBe(true);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);
      }),
    ),
  );

  effectIt.effect("ignores close events from replaced main windows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_replaced_window_close");
        yield* manager.registerWebview("tab_replaced_window_close", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);

        closeFirstWindow?.();
        yield* manager.startRecording("tab_replaced_window_close");
        expect(firstWindowThrottling).not.toHaveBeenCalled();
        expect(replacementWindowThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_replaced_window_close");
        expect(replacementWindowThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("releases frame capture when the main window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not arm recording after the main window closes during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        closeMainWindow?.();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("tells the server when a tab it renders natively closes", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const nextType = Queue.take(lines).pipe(
        Effect.map((line) => /"type":"(\w+)"/.exec(line)?.[1]),
      );
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      fromId.mockReturnValue(
        Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        }),
      );
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.createTab("tab_1", { serverTab });
      yield* manager.registerWebview("tab_1", 42);
      expect(yield* nextType).toBe("attached");
      yield* manager.closeTab("tab_1");
      expect(yield* nextType).toBe("detached");
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("discards a screenshot that resolves after its guest is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("stale-png"),
          toJPEG: () => Buffer.from("stale-jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const pending = Promise.withResolvers<typeof image>();
        const capturePage = vi.fn(() => pending.promise);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const fiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(capturePage).toHaveBeenCalledOnce();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 43));
        yield* manager.registerWebview("tab_1", 43);
        pending.resolve(image);
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(writeFile).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("grants each concurrent preview recording its own tab frame", () =>
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
        const host = makeTestHostWebContents();
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            mainFrame: { routingId: id },
            hostWebContents: host,
            executeJavaScript: vi.fn(async () =>
              id === 41 ? { width: 800, height: 600 } : { width: 390, height: 844 },
            ),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoadingMainFrame: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
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
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);

        const grants: Array<{ video?: unknown }> = [];
        const takeGrant = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            grants.push(value);
          });

        yield* manager.startRecording("tab_1");
        takeGrant();
        yield* manager.startRecording("tab_2");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
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

  effectIt.effect("only lets the host frame that armed a recording claim its stream", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        takeGrant({ frameTreeNodeId: 999 });
        takeGrant();

        expect(grants).toEqual([{}, { video: { routingId: 41 } }]);
        yield* manager.stopRecording("tab_race_a");
      }),
    ),
  );

  effectIt.effect("reclaims the arm slot from a destroyed webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant, destroy } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        destroy(41);
        yield* manager.startRecording("tab_race_b");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.stopRecording("tab_race_b");
      }),
    ),
  );

  effectIt.effect("gates recording decorations and isolates failed subscribers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const callbacks = new Map<
          string,
          (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined
        >();
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 800, height: 600 }),
          })),
          {
            ipc: {
              on: (
                channel: string,
                callback: (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined,
              ) => callbacks.set(channel, callback),
              off: vi.fn(),
            },
          },
        );
        fromId.mockReturnValue(contents as never);
        yield* manager.createTab("tab_recording_input");
        yield* manager.registerWebview("tab_recording_input", 42);
        const received: DesktopPreviewRecordingInputEvent[] = [];
        yield* manager.subscribeRecordingInputs(() => Effect.die("renderer unavailable"));
        yield* manager.subscribeRecordingInputs((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        );
        const send = (input: unknown) =>
          Effect.gen(function* () {
            const fiber = callbacks.get("preview:recording-input")?.(null, input);
            if (fiber) yield* Fiber.join(fiber);
          });
        const key = { type: "key", label: "⌘C", held: true, width: 800 };
        const pointer = {
          type: "pointer",
          phase: "down",
          x: 120,
          y: 80,
          width: 800,
          height: 600,
        };
        yield* send(key);
        expect(received).toEqual([]);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: true,
          showMousePresses: false,
        });
        yield* send(key);
        yield* send(pointer);
        yield* send({ ...key, width: 0 });
        expect(received).toEqual([{ tabId: "tab_recording_input", input: key }]);
        yield* manager.stopRecording("tab_recording_input");
        yield* send(key);
        expect(received).toHaveLength(1);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: false,
          showMousePresses: true,
        });
        yield* send(key);
        yield* send(pointer);
        expect(received.at(-1)).toEqual({ tabId: "tab_recording_input", input: pointer });
        expect(received).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect("continues native recording when the source warmup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeTestHostWebContents();
        const webContents = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        });
        fromId.mockReturnValue(webContents);

        yield* manager.createTab("tab_recording_warmup_failure");
        yield* manager.registerWebview("tab_recording_warmup_failure", 42);

        yield* manager.startRecording("tab_recording_warmup_failure");
        expect(capturePage).toHaveBeenCalledTimes(2);

        const handler = host.displayMediaHandler();
        const streams: Array<{ video?: unknown }> = [];
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        expect(streams).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.stopRecording("tab_recording_warmup_failure");
      }),
    ),
  );

  effectIt.effect("serializes recording source acquisition with webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturedImage = {
          toJPEG: () => Buffer.from("unused-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        const capturePage = vi
          .fn<() => Promise<TestCapturedPreviewImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<TestCapturedPreviewImage>((resolve) => {
                markWarmupStarted();
                finishWarmup = resolve;
              }),
          )
          .mockResolvedValue(capturedImage);
        const initialWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementOn = vi.fn();
        const replacementWebContents = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          on: replacementOn,
        });
        fromId.mockImplementation((id) => {
          if (id === 42) return initialWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });

        yield* manager.createTab("tab_recording_replacement_race");
        yield* manager.registerWebview("tab_recording_replacement_race", 42);
        const start = yield* manager
          .startRecording("tab_recording_replacement_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        const replacement = yield* manager
          .registerWebview("tab_recording_replacement_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementOn).not.toHaveBeenCalled();

        finishWarmup(capturedImage);
        yield* Fiber.join(start);
        yield* Fiber.join(replacement);
        expect(replacementOn).toHaveBeenCalled();
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_recording_replacement_race");
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
        ]);
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
          () => new Promise<void>(() => {}),
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
        yield* Effect.yieldNow;
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
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (...args) => {
              listeners.delete(event);
              listener(...args);
            });
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
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
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({
          url: "about:blank",
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps annotation send grants isolated and updates an active pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const picked = new Map<number, (event: unknown, ...args: unknown[]) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("annotation"),
          toDataURL: () => "data:image/png;base64,YW5ub3RhdGlvbg==",
          getSize: () => ({ width: 10, height: 10 }),
        }));
        const guests = new Map(
          [42, 43, 44].map(
            (id) =>
              [
                id,
                Object.assign(makeTestPreviewWebContents(capturePage, id), {
                  isFocused: () => true,
                  once: vi.fn(),
                  ipc: {
                    on: vi.fn(
                      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
                        if (channel === "preview:element-picked") picked.set(id, listener);
                      },
                    ),
                    off: vi.fn(),
                    removeListener: vi.fn(),
                  },
                }),
              ] as const,
          ),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.createTab("tab_a");
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_a", 42);
        yield* manager.registerWebview("tab_b", 43);
        yield* manager.setAnnotationSendEnabled("tab_a", true);
        const annotation = {
          id: "annotation-scopes",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        };
        for (const [tabId, id, nextGrant, expected] of [
          ["tab_b", 43, undefined, "attach"],
          ["tab_a", 42, false, "attach"],
          ["tab_a", 42, true, "send"],
        ] as const) {
          const pick = yield* manager.pickElement(tabId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          if (nextGrant !== undefined) {
            yield* manager.setAnnotationSendEnabled(tabId, nextGrant);
          }
          picked.get(id)?.({}, annotation, null, "send");
          const result = yield* Fiber.join(pick);
          expect(result?.annotation.id).toBe(annotation.id);
          expect(result?.submission).toBe(expected);
        }
        yield* manager.registerWebview("tab_a", 44);
        const replacementPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(replacementPick))?.submission).toBe("send");
        yield* manager.closeTab("tab_a");
        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 44);
        const reopenedPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(reopenedPick))?.submission).toBe("attach");
      }),
    ),
  );

  describe("annotation screenshots", () => {
    const captureAnnotation = (
      cropRect: PreviewAnnotationRect | null,
      targets: Partial<Pick<PreviewAnnotationPayload, "elements" | "regions" | "strokes">> = {},
      emptyImage?: "viewport" | "crop",
    ) =>
      withManager((manager) =>
        Effect.gen(function* () {
          let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const crop = vi.fn((rect: Electron.Rectangle) => ({
            isEmpty: () => emptyImage === "crop",
            getSize: () =>
              emptyImage === "crop"
                ? { width: 0, height: 0 }
                : { width: rect.width, height: rect.height },
            toDataURL: () => (emptyImage === "crop" ? "data:," : "data:image/png;base64,cropped"),
          }));
          const capturePage = vi.fn(async () => ({
            isEmpty: () => emptyImage === "viewport",
            getSize: () =>
              emptyImage === "viewport" ? { width: 0, height: 0 } : { width: 2000, height: 1200 },
            toJPEG: () => Buffer.from("unused"),
            toDataURL: () => (emptyImage === "viewport" ? "data:," : "data:image/png;base64,full"),
            crop,
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              isFocused: () => true,
              once: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof onPicked) => {
                  if (channel === "preview:element-picked") onPicked = listener;
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }),
          );

          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          onPicked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com",
              pageTitle: "Example",
              comment: "Tighten this spacing",
              elements: [],
              regions: [],
              strokes: [],
              ...targets,
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
            cropRect,
            "attach",
            2,
          );

          const result = yield* Fiber.join(pick);
          expect(capturePage).toHaveBeenCalledExactlyOnceWith();
          expect(result?.annotation.comment).toBe("Tighten this spacing");
          expect(result?.submission).toBe("attach");
          return { result, crop };
        }),
      );

    effectIt.effect("clips a partially visible selection to the captured viewport", () =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(
          { x: -40, y: 570, width: 240, height: 110 },
          { regions: [{ id: "region_1", rect: { x: -20, y: 590, width: 200, height: 70 } }] },
        );
        expect(crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 1140, width: 400, height: 60 });
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: 400,
          height: 60,
        });
      }),
    );

    effectIt.effect.each([
      {
        name: "an offscreen crop without individual target bounds",
        cropRect: { x: 1010, y: 40, width: 100, height: 70 },
        regions: [],
      },
      {
        name: "padding overlapping the viewport while its target is offscreen",
        cropRect: { x: 40, y: -100, width: 240, height: 110 },
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
      {
        name: "a union spanning the viewport with both targets offscreen",
        cropRect: { x: -230, y: 40, width: 1460, height: 110 },
        regions: [
          { id: "region_1", rect: { x: -210, y: 60, width: 200, height: 70 } },
          { id: "region_2", rect: { x: 1010, y: 60, width: 200, height: 70 } },
        ],
      },
      {
        name: "an offscreen target when crop bounds are missing",
        cropRect: null,
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
    ])("does not attach $name", ({ cropRect, regions }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, { regions });
        expect(crop).not.toHaveBeenCalled();
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
      }),
    );

    // regression: #18441 zero-area strokes on the viewport edge must still get a screenshot crop
    effectIt.effect.each([
      {
        name: "zero-width SVG line on the left edge",
        rect: { x: 0, y: 60, width: 0, height: 70 },
        cropRect: { x: -20, y: 40, width: 40, height: 110 },
        expectedCrop: { x: 0, y: 80, width: 40, height: 220 },
      },
      {
        name: "zero-height SVG line on the top edge",
        rect: { x: 60, y: 0, width: 70, height: 0 },
        cropRect: { x: 40, y: -20, width: 110, height: 40 },
        expectedCrop: { x: 80, y: 0, width: 220, height: 40 },
      },
    ])("captures a stroked $name", ({ rect, cropRect, expectedCrop }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, {
          elements: [
            {
              id: "element_1",
              rect,
              element: {
                pageUrl: "https://example.com",
                pageTitle: "Example",
                tagName: "line",
                selector: "svg > line",
                htmlPreview: '<line stroke="black" stroke-width="2" />',
                componentName: null,
                source: null,
                stack: [],
                styles: "stroke: black; stroke-width: 2px;",
                pickedAt: "2026-06-11T00:00:00.000Z",
              },
            },
          ],
        });
        expect(crop).toHaveBeenCalledExactlyOnceWith(expectedCrop);
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: expectedCrop.width,
          height: expectedCrop.height,
        });
      }),
    );
  });

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
});
