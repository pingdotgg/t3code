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
  createFromPath,
  fromId,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number): Electron.WebContents | null => null),
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
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
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
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
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

const keyboardInputFromPacket = (packet: Electron.KeyboardInputEvent): Electron.Input => {
  const modifiers = new Set(packet.modifiers ?? []);
  const shift = modifiers.has("shift");
  const keyCode = String(packet.keyCode);
  const namedKeys: Readonly<Record<string, { readonly key: string; readonly code: string }>> = {
    Enter: { key: "Enter", code: "Enter" },
    Escape: { key: "Escape", code: "Escape" },
    Backspace: { key: "Backspace", code: "Backspace" },
    Tab: { key: "Tab", code: "Tab" },
    Shift: { key: "Shift", code: "ShiftLeft" },
    Control: { key: "Control", code: "ControlLeft" },
    Alt: { key: "Alt", code: "AltLeft" },
    Meta: { key: "Meta", code: "MetaLeft" },
    Space: { key: " ", code: "Space" },
    Left: { key: "ArrowLeft", code: "ArrowLeft" },
    Right: { key: "ArrowRight", code: "ArrowRight" },
    Up: { key: "ArrowUp", code: "ArrowUp" },
    Down: { key: "ArrowDown", code: "ArrowDown" },
  };
  const printableKeys: Readonly<
    Record<string, { readonly key: string; readonly shiftedKey: string; readonly code: string }>
  > = {
    "`": { key: "`", shiftedKey: "~", code: "Backquote" },
    "1": { key: "1", shiftedKey: "!", code: "Digit1" },
    "2": { key: "2", shiftedKey: "@", code: "Digit2" },
    "3": { key: "3", shiftedKey: "#", code: "Digit3" },
    "4": { key: "4", shiftedKey: "$", code: "Digit4" },
    "5": { key: "5", shiftedKey: "%", code: "Digit5" },
    "6": { key: "6", shiftedKey: "^", code: "Digit6" },
    "7": { key: "7", shiftedKey: "&", code: "Digit7" },
    "8": { key: "8", shiftedKey: "*", code: "Digit8" },
    "9": { key: "9", shiftedKey: "(", code: "Digit9" },
    "0": { key: "0", shiftedKey: ")", code: "Digit0" },
    "-": { key: "-", shiftedKey: "_", code: "Minus" },
    "=": { key: "=", shiftedKey: "+", code: "Equal" },
    "\\": { key: "\\", shiftedKey: "|", code: "Backslash" },
    "[": { key: "[", shiftedKey: "{", code: "BracketLeft" },
    "]": { key: "]", shiftedKey: "}", code: "BracketRight" },
    ";": { key: ";", shiftedKey: ":", code: "Semicolon" },
    "'": { key: "'", shiftedKey: '"', code: "Quote" },
    ",": { key: ",", shiftedKey: "<", code: "Comma" },
    ".": { key: ".", shiftedKey: ">", code: "Period" },
    "/": { key: "/", shiftedKey: "?", code: "Slash" },
  };
  const named = namedKeys[keyCode];
  const printable = printableKeys[keyCode];
  const letter = /^[A-Z]$/.test(keyCode);
  const key =
    named?.key ??
    (printable ? (shift ? printable.shiftedKey : printable.key) : undefined) ??
    (letter && !shift ? keyCode.toLowerCase() : keyCode);
  const code = named?.code ?? printable?.code ?? (letter ? `Key${keyCode}` : keyCode);
  return {
    type: packet.type === "keyUp" ? "keyUp" : "keyDown",
    key,
    code,
    meta: modifiers.has("meta"),
    shift,
    control: modifiers.has("control") || modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    modifiers: packet.modifiers ?? [],
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
  };
};

const makeKeyboardWebContents = (options: {
  readonly hostWebContents: Electron.WebContents;
  readonly id?: number;
  readonly initialFocusedFrame?: "main" | "child" | null;
  readonly initialDevToolsOpened?: boolean;
  readonly onIsDevToolsOpened?: () => void;
  readonly onSendInputEvent?: (packet: Electron.KeyboardInputEvent) => void;
  readonly onSetIgnoreMenuShortcuts?: (ignore: boolean) => void;
  readonly sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}) => {
  let beforeInput: ((event: Electron.Event, input: Electron.Input) => void) | undefined;
  let humanInput: ((event: Electron.IpcMainEvent, signal: unknown) => void) | undefined;
  let confirmDelivery = true;
  let devToolsOpened = options.initialDevToolsOpened ?? false;
  const activity: string[] = [];
  let mainFrameProcessId = 100;
  let mainFrameRoutingId = 200;
  let mainFrameDetached = false;
  const mainFrame = {
    get detached() {
      return mainFrameDetached;
    },
    get processId() {
      return mainFrameProcessId;
    },
    get routingId() {
      return mainFrameRoutingId;
    },
  } as Electron.WebFrameMain;
  const childFrame = {
    detached: false,
    processId: 101,
    routingId: 201,
  } as Electron.WebFrameMain;
  let focusedFrame =
    options.initialFocusedFrame === null
      ? null
      : options.initialFocusedFrame === "child"
        ? childFrame
        : mainFrame;
  const focus = vi.fn();
  const off = vi.fn();
  const openDevTools = vi.fn();
  const reload = vi.fn();
  const setIgnoreMenuShortcuts = vi.fn((ignore: boolean) => {
    activity.push(`menu:${ignore}`);
    options.onSetIgnoreMenuShortcuts?.(ignore);
  });
  const sendCommand = vi.fn(
    options.sendCommand ??
      (async (method: string, params?: Record<string, unknown>) => {
        if (method !== "Runtime.evaluate") return undefined;
        return {
          result: {
            value:
              typeof params?.["expression"] === "string" &&
              params["expression"].includes("document.activeElement?.tagName")
                ? false
                : { ok: true },
          },
        };
      }),
  );
  const sendInputEvent = vi.fn((packet: Electron.KeyboardInputEvent) => {
    activity.push(`send:${packet.type}`);
    options.onSendInputEvent?.(packet);
    if (packet.type === "char") return;
    const input = keyboardInputFromPacket(packet);
    let prevented = false;
    const event = {
      preventDefault: vi.fn(() => {
        prevented = true;
      }),
    } as unknown as Electron.Event;
    activity.push(`before:${input.type}`);
    beforeInput?.(event, input);
    if (confirmDelivery && !prevented) {
      queueMicrotask(() => {
        const phase = packet.type === "keyUp" ? "up" : "down";
        activity.push(`receipt:${phase}`);
        humanInput?.(
          {
            sender: webContents,
            senderFrame: mainFrame,
            processId: mainFrameProcessId,
            frameId: mainFrameRoutingId,
          } as Electron.IpcMainEvent,
          {
            kind: "key",
            phase,
            key: input.key,
            code: input.code,
            meta: input.meta,
            shift: input.shift,
            control: input.control,
            alt: input.alt,
          },
        );
      });
    }
  });
  const capturedImage = {
    getSize: () => ({ width: 1, height: 1 }),
    resize: () => capturedImage,
    toPNG: () => Buffer.from("png"),
  };
  const listeners = new Map<string, (...args: never[]) => void>();
  const webContents = {
    id: options.id ?? 42,
    hostWebContents: options.hostWebContents,
    mainFrame,
    get focusedFrame() {
      return focusedFrame;
    },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoading: () => false,
    isDevToolsOpened: () => {
      options.onIsDevToolsOpened?.();
      return devToolsOpened;
    },
    focus,
    reload,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      if (event === "before-input-event") beforeInput = listener as typeof beforeInput;
      listeners.set(event, listener);
    }),
    once: vi.fn(),
    off,
    ipc: {
      on: vi.fn((channel: string, listener: typeof humanInput) => {
        if (channel === "preview:human-input") humanInput = listener;
      }),
      off: vi.fn(),
    },
    send: webviewSend,
    sendInputEvent,
    setIgnoreMenuShortcuts,
    openDevTools,
    capturePage: vi.fn(async () => capturedImage),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand,
      on: vi.fn(),
      off: vi.fn(),
    },
  } as unknown as Electron.WebContents;
  return {
    activity,
    focus,
    off,
    openDevTools,
    reload,
    sendCommand,
    sendInputEvent,
    setIgnoreMenuShortcuts,
    webContents,
    emitPhysicalInput(input: Electron.Input) {
      const preventDefault = vi.fn();
      beforeInput?.({ preventDefault } as unknown as Electron.Event, input);
      return preventDefault;
    },
    emitHumanInput(
      signal: unknown,
      eventOptions?: {
        readonly frame?: "main" | "child" | null;
        readonly frameId?: number;
        readonly processId?: number;
      },
    ) {
      const senderFrame =
        eventOptions?.frame === null
          ? null
          : eventOptions?.frame === "child"
            ? childFrame
            : mainFrame;
      humanInput?.(
        {
          sender: webContents,
          senderFrame,
          processId: eventOptions?.processId ?? senderFrame?.processId ?? -1,
          frameId: eventOptions?.frameId ?? senderFrame?.routingId ?? -1,
        } as Electron.IpcMainEvent,
        signal,
      );
    },
    emitNavigation(options?: { readonly processId?: number; readonly frameId?: number }) {
      mainFrameProcessId = options?.processId ?? mainFrameProcessId + 1;
      mainFrameRoutingId = options?.frameId ?? mainFrameRoutingId + 1;
      listeners.get("did-navigate")?.();
    },
    emitNavigationStarted(options?: {
      readonly isMainFrame?: boolean;
      readonly isSameDocument?: boolean;
    }) {
      listeners.get("did-start-navigation")?.({
        isMainFrame: options?.isMainFrame ?? true,
        isSameDocument: options?.isSameDocument ?? false,
      } as never);
    },
    emitInPageNavigation() {
      listeners.get("did-navigate-in-page")?.();
    },
    setMainFrameDetached(value: boolean) {
      mainFrameDetached = value;
    },
    setConfirmDelivery(value: boolean) {
      confirmDelivery = value;
    },
    setDevToolsOpened(value: boolean) {
      devToolsOpened = value;
    },
    setFocusedFrame(value: "main" | "child" | null) {
      focusedFrame = value === null ? null : value === "child" ? childFrame : mainFrame;
    },
  };
};

const makeKeyboardInput = (
  type: "keyDown" | "keyUp",
  key: string,
  options?: { readonly meta?: boolean; readonly control?: boolean },
): Electron.Input => ({
  type,
  key,
  code: `Key${key.toUpperCase()}`,
  meta: options?.meta ?? false,
  shift: false,
  control: options?.control ?? false,
  alt: false,
  modifiers: [
    ...(options?.meta ? (["meta"] as const) : []),
    ...(options?.control ? (["control"] as const) : []),
  ],
  isAutoRepeat: false,
  isComposing: false,
  location: 0,
});

const makeKeyboardSignal = (
  phase: "down" | "up",
  key: string,
  options?: { readonly meta?: boolean; readonly control?: boolean },
) => ({
  kind: "key" as const,
  phase,
  key,
  code: `Key${key.toUpperCase()}`,
  meta: options?.meta ?? false,
  shift: false,
  control: options?.control ?? false,
  alt: false,
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
  const fetch = vi.fn(
    options?.fetch ??
      (async () =>
        new Response(new Uint8Array(sourcePng), {
          headers: { "content-type": "image/png" },
        })),
  );
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? "") : TEST_FAVICON,
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
    isLoading: () => loading,
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

const settle = function* (until: () => boolean) {
  for (let attempt = 0; attempt < 30 && !until(); attempt++) {
    yield* Effect.promise(() => Promise.resolve());
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

  effectIt.effect("rejects a destroyed webview during registration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const getType = vi.fn(() => "webview" as const);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => true,
          getType,
        } as never);
        yield* manager.createTab("tab_destroyed_registration");

        const exit = yield* Effect.exit(manager.registerWebview("tab_destroyed_registration", 42));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewWebContentsNotFoundError",
            tabId: "tab_destroyed_registration",
            webContentsId: 42,
          });
        }
        expect(getType).not.toHaveBeenCalled();
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

  effectIt.effect("detaches a destroyed webview instead of navigating it", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_destroyed_navigation");
        yield* manager.registerWebview("tab_destroyed_navigation", 42);
        yield* manager.setColorScheme("tab_destroyed_navigation", "dark");
        preview.setDestroyed(true);

        yield* manager.navigate("tab_destroyed_navigation", "https://example.com/");

        expect(preview.loadURL).not.toHaveBeenCalled();
        expect(preview.reload).not.toHaveBeenCalled();
        expect(preview.off).toHaveBeenCalled();
        expect(preview.debuggerOff).toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: null,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
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

  effectIt.effect("publishes a canonical favicon origin while the page is loading", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({
          url: `http://localhost:3200/${"x".repeat(3_000)}`,
        });
        preview.setLoading(true);
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_loading");
        yield* manager.registerWebview("tab_favicon_loading", 42);

        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toMatchObject({
          dataUrl: TEST_FAVICON,
          pageUrl: "http://localhost:3200",
        });
        expect(states.at(-1)?.favicon?.capturedAt).toEqual(expect.any(Number));
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
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
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* settle(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* settle(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* settle(() => false);

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("allows an identical retry after an undecodable capture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let rasterizations = 0;
        const preview = makeFaviconWebContents({
          rasterize: async () => (++rasterizations === 1 ? null : TEST_FAVICON),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_retry");
        yield* manager.registerWebview("tab_favicon_retry", 42);
        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;

        faviconUpdated({} as never, ["http://localhost:3200/favicon.png"] as never);
        yield* settle(() => rasterizations === 1);
        yield* settle(() => false);
        faviconUpdated({} as never, ["http://localhost:3200/favicon.png"] as never);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(rasterizations).toBe(2);
        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
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
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => preview.fetch.mock.calls.length === 1);
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
        yield* settle(() => false);

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("retains a favicon when reloading the current URL without a new event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reload");
        yield* manager.registerWebview("tab_favicon_reload", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.navigate("tab_favicon_reload", "http://localhost:3200/");

        expect(preview.reload).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  effectIt.effect("clears a published favicon after a confirmed cross-origin navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_origin");
        yield* manager.registerWebview("tab_favicon_origin", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        preview.setUrl("https://example.com/");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success");

        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect(
    "retains the previous document icon across a failed cross-origin navigation",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          fromId.mockReturnValue(preview.webContents);
          const states: PreviewManager.PreviewTabState[] = [];
          yield* manager.subscribeStateChanges((_tabId, state) =>
            Effect.sync(() => {
              states.push(state);
            }),
          );
          yield* manager.createTab("tab_favicon_failed_origin");
          yield* manager.registerWebview("tab_favicon_failed_origin", 42);
          preview.listeners.get("page-favicon-updated")?.(
            {} as never,
            ["http://localhost:3200/favicon.png"] as never,
          );
          yield* settle(() => states.at(-1)?.favicon !== undefined);

          preview.listeners.get("did-fail-load")?.(
            {} as never,
            -105 as never,
            "Name not resolved" as never,
            "https://unreachable.example/" as never,
            true as never,
          );
          yield* settle(() => states.at(-1)?.navStatus.kind === "LoadFailed");
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);

          preview.listeners.get("did-navigate")?.({} as never);
          yield* settle(() => states.at(-1)?.navStatus.kind === "Success");
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
        }),
      ),
  );

  effectIt.effect("does not resurrect an icon after a confirmed about:blank document", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_blank");
        yield* manager.registerWebview("tab_favicon_blank", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        preview.setUrl("about:blank");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Idle");
        expect(states.at(-1)?.favicon).toBeUndefined();

        preview.setUrl("http://localhost:3200/");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success");
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("clears a published favicon when a replacement webview attaches", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initial = makeFaviconWebContents({ id: 42 });
        const replacement = makeFaviconWebContents({ id: 43 });
        fromId.mockImplementation((id?: number) => {
          if (id === 42) return initial.webContents;
          if (id === 43) return replacement.webContents;
          return null;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_replace");
        yield* manager.registerWebview("tab_favicon_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.registerWebview("tab_favicon_replace", 43);

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* settle(() => false);

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
        const initial = makeFaviconWebContents({ id: 42 });
        const replacement = makeFaviconWebContents({ id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  effectIt.effect("preserves a favicon when the active attachment registers again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reregister");
        yield* manager.registerWebview("tab_favicon_reregister", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.registerWebview("tab_favicon_reregister", 42);

        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  // The guest reports whatever zoom level Chromium handed it from the app
  // window, so the tab's own zoom is the source of truth in both directions:
  // asserted onto every guest, never read back off one.
  effectIt.effect("keeps the tab's own zoom instead of the guest's reported zoom", () =>
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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

        // An app zoom leaves the guest reporting the inherited level. Navigating
        // must not adopt it as the preview's zoom.
        effectiveZoom = 0.8;
        url = "https://example.com/after-app-zoom";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1);

        // Only the preview's own zoom controls move it.
        yield* manager.zoomIn("tab_zoom");
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);

        zoomReadable = false;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.1);

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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

  // Zooming the app UI pushes the window's zoom level onto every guest, so the
  // preview has to be put back at the zoom the user gave it.
  effectIt.effect("re-applies each tab's own zoom when the app window zooms", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

        yield* manager.createTab("tab_reapply");
        yield* manager.registerWebview("tab_reapply", 42);
        yield* manager.zoomIn("tab_reapply");
        setZoomFactor.mockClear();

        yield* manager.reapplyZoom();

        expect(setZoomFactor).toHaveBeenCalledTimes(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
      }),
    ),
  );

  // did-attach and dom-ready both re-register the guest that is already
  // attached, and a guest that just inherited the app window's zoom needs its
  // own back — without that round trip republishing tab state.
  effectIt.effect("re-asserts the tab's zoom when the active guest registers again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_reregister_zoom");
        yield* manager.registerWebview("tab_reregister_zoom", 42);
        yield* manager.zoomIn("tab_reregister_zoom");
        setZoomFactor.mockClear();
        const publishedBefore = states.length;

        yield* manager.registerWebview("tab_reregister_zoom", 42);

        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
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
              setAudioMuted: vi.fn(),
              isCurrentlyAudible: () => false,
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
      /**
       * Starts playing between the attach-time read and the post-attach
       * reconcile, without a delivered event — the window in which
       * audio-state-changed fires against a guest the tab does not own yet.
       */
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
        isLoading: () => false,
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

  effectIt.effect("mutes the guest and re-applies the mute across webview swaps", () =>
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
        yield* manager.createTab("tab_audio");
        yield* manager.registerWebview("tab_audio", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audioMuted).toBe(false);

        yield* manager.setAudioMuted("tab_audio", true);

        expect(first.setAudioMuted).toHaveBeenCalledWith(true);
        expect(states.at(-1)?.audioMuted).toBe(true);

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio", 43);
        yield* Effect.yieldNow;

        expect(replacement.setAudioMuted).toHaveBeenCalledWith(true);
        expect(states.at(-1)?.audioMuted).toBe(true);

        yield* manager.setAudioMuted("tab_audio", false);

        expect(replacement.setAudioMuted).toHaveBeenLastCalledWith(false);
        expect(states.at(-1)?.audioMuted).toBe(false);
      }),
    ),
  );

  effectIt.effect("fails and rolls back when the guest refuses a mute", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_fail");
        yield* manager.registerWebview("tab_audio_fail", 42);
        yield* Effect.yieldNow;

        guest.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest refused");
        });
        const exit = yield* manager.setAudioMuted("tab_audio_fail", true).pipe(Effect.exit);

        // Reporting success would draw the tab as muted while it keeps playing.
        expect(Exit.isFailure(exit)).toBe(true);
        expect(states.at(-1)?.audioMuted).toBe(false);
      }),
    ),
  );

  effectIt.effect("still registers a guest that refuses the mute reassert", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        yield* manager.createTab("tab_audio_attach_fail");
        yield* manager.registerWebview("tab_audio_attach_fail", 42);
        yield* Effect.yieldNow;
        yield* manager.setAudioMuted("tab_audio_attach_fail", true);

        const replacement = makeAudioWebContents(43);
        // Fails the post-attach settle, not the pre-publish apply.
        replacement.setAudioMuted.mockImplementationOnce(() => undefined);
        replacement.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest went away");
        });
        fromId.mockReturnValue(replacement.wc);

        // Reconciliation is best-effort: a guest dying mid-attach must not fail
        // the registration it was attaching for.
        const exit = yield* manager.registerWebview("tab_audio_attach_fail", 43).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
      }),
    ),
  );

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

        // audio-state-changed for this transition was dropped: it fired before
        // the tab owned the guest. Without a post-attach reconcile the icon
        // stays wrong until the next real transition, which may never come.
        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("publishes audibility transitions and drops repeats", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audible");
        yield* manager.registerWebview("tab_audible", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(false);

        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(true);

        // Chromium re-emits per media element; only real transitions publish.
        const publishedAfterFirst = states.length;
        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.length).toBe(publishedAfterFirst);

        guest.emitAudioState(false);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(false);
        expect(states.length).toBeGreaterThan(publishedAfterFirst);
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

  effectIt.effect("carries mute and audibility across navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_nav");
        yield* manager.registerWebview("tab_audio_nav", 42);
        yield* Effect.yieldNow;

        yield* manager.setAudioMuted("tab_audio_nav", true);
        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(true);

        yield* manager.navigate("tab_audio_nav", "https://example.com/next");
        yield* Effect.yieldNow;

        // navigate runs before loadURL swaps the document, so the old page can
        // still be playing. Dropping audibility here would lose the speaker
        // with no transition left to bring it back.
        expect(states.at(-1)?.audioMuted).toBe(true);
        expect(states.at(-1)?.audible).toBe(true);

        // Chromium reports the real stop once the new document takes over.
        guest.emitAudioState(false);
        yield* Effect.yieldNow;
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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

  effectIt.effect("keeps window unthrottled until the final frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const webContentsById = new Map([
          [41, makeTestPreviewWebContents(capturePage, 41)],
          [42, makeTestPreviewWebContents(capturePage, 42)],
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
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
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

  effectIt.effect("does not publish a replacement window when capture reconciliation fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn(() => {
          throw new Error("replacement throttling update failed");
        });
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_replacement_failure");
        yield* manager.registerWebview("tab_capture_replacement_failure", 42);
        yield* manager.startRecording("tab_capture_replacement_failure");

        const failedReplacement = yield* Effect.exit(
          manager.setMainWindow({
            isDestroyed: () => false,
            once: vi.fn(),
            webContents: { setBackgroundThrottling },
          } as never),
        );
        expect(Exit.isFailure(failedReplacement)).toBe(true);

        yield* manager.stopRecording("tab_capture_replacement_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
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
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42)],
          [43, makeTestPreviewWebContents(capturePage, 43)],
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

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
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
            setAudioMuted: vi.fn(),
            isCurrentlyAudible: () => false,
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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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
        const setBackgroundThrottling = vi.fn();
        const mainWindowWebContents = { setBackgroundThrottling };
        const jpeg = Buffer.from("shared-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue({
          id: 42,
          hostWebContents: mainWindowWebContents,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: mainWindowWebContents,
        } as never);

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

        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
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
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        const framesBeforePictureInPictureOnlyTick = pictureInPictureSend.mock.calls.length;
        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(3);
        expect(pictureInPictureSend.mock.calls.length).toBeGreaterThan(
          framesBeforePictureInPictureOnlyTick,
        );
        expect(recordingFrames).toHaveLength(1);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("picture-in-picture throttling restore failed");
        });
        yield* manager.closePictureInPicture("tab_pip");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true], [true]]);
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
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

  effectIt.effect("navigates the guest history when the thumb-button ipc fires", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let mouseNavigate: ((event: unknown, payload: unknown) => void) | undefined;
        const goBack = vi.fn();
        const goForward = vi.fn();
        let canGoBack = true;
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof mouseNavigate) => {
              if (channel === "preview:mouse-navigate") mouseNavigate = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: {
            canGoBack: () => canGoBack,
            canGoForward: () => true,
            goBack,
            goForward,
          },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_nav");
        yield* manager.registerWebview("tab_nav", 42);
        expect(mouseNavigate).toBeDefined();

        mouseNavigate?.({}, { direction: "back" });
        yield* Effect.yieldNow;
        expect(goBack).toHaveBeenCalledOnce();

        mouseNavigate?.({}, { direction: "forward" });
        yield* Effect.yieldNow;
        expect(goForward).toHaveBeenCalledOnce();

        // Ignores unknown payloads and never navigates when history is exhausted.
        mouseNavigate?.({}, { direction: "sideways" });
        canGoBack = false;
        mouseNavigate?.({}, { direction: "back" });
        yield* Effect.yieldNow;
        expect(goBack).toHaveBeenCalledOnce();
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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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

  effectIt.effect("types through the page runtime without native text input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        yield* manager.automationType("tab_input", { text: "hé🙂", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });

        const calls = guest.sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        expect(
          calls.find(
            ([method, params]) =>
              method === "Runtime.evaluate" &&
              typeof params?.["expression"] === "string" &&
              params["expression"].includes('const text = "hé🙂"') &&
              params["expression"].includes('document.execCommand("insertText"'),
          ),
        ).toBeDefined();
        expect(
          calls.find(
            ([method, params]) =>
              method === "Runtime.evaluate" &&
              typeof params?.["expression"] === "string" &&
              params["expression"].includes('const text = ""') &&
              params["expression"].includes("Object.getOwnPropertyDescriptor"),
          ),
        ).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("sends native key packets to a never-focused guest and confirms delivery", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostSendInputEvent = vi.fn();
        const hostWebContents = {
          sendInputEvent: hostSendInputEvent,
        } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        yield* manager.automationPress("tab_input", { key: "x" });
        yield* manager.automationPress("tab_input", { key: "Enter" });
        yield* manager.automationPress("tab_input", { key: "z", modifiers: ["Meta"] });
        yield* manager.automationPress("tab_input", { key: "Escape" });
        yield* manager.automationPress("tab_input", { key: "Escape" });
        yield* manager.automationPress("tab_input", { key: "Escape" });

        expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet)).toEqual([
          { type: "rawKeyDown", keyCode: "X", modifiers: [] },
          { type: "char", keyCode: "x", modifiers: [] },
          { type: "keyUp", keyCode: "X", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
          { type: "char", keyCode: "\r", modifiers: [] },
          { type: "keyUp", keyCode: "Enter", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Z", modifiers: ["meta"] },
          { type: "keyUp", keyCode: "Z", modifiers: ["meta"] },
          { type: "rawKeyDown", keyCode: "Escape", modifiers: [] },
          { type: "keyUp", keyCode: "Escape", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Escape", modifiers: [] },
          { type: "keyUp", keyCode: "Escape", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Escape", modifiers: [] },
          { type: "keyUp", keyCode: "Escape", modifiers: [] },
        ]);
        expect(guest.activity.slice(0, 9)).toEqual([
          "menu:true",
          "send:rawKeyDown",
          "before:keyDown",
          "send:char",
          "send:keyUp",
          "before:keyUp",
          "receipt:down",
          "receipt:up",
          "menu:false",
        ]);
        expect(guest.focus).not.toHaveBeenCalled();
        expect(hostSendInputEvent).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual(
          Array.from({ length: 6 }, () => [[true], [false]]).flat(),
        );
        const methods = guest.sendCommand.mock.calls.map(([method]) => method);
        expect(methods).not.toContain("Input.dispatchKeyEvent");
        expect(methods).not.toContain("Page.bringToFront");
        expect(methods).not.toContain("Emulation.setFocusEmulationEnabled");
      }),
    ),
  );

  effectIt.effect("confirms both phases of named modifier presses", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostSendInputEvent = vi.fn();
        const hostWebContents = {
          sendInputEvent: hostSendInputEvent,
        } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_modifiers");
        yield* manager.registerWebview("tab_modifiers", 42);

        for (const key of ["Shift", "Control", "Alt", "Meta"] as const) {
          yield* manager.automationPress("tab_modifiers", { key });
        }
        yield* manager.automationPress("tab_modifiers", { key: "x" });

        expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet)).toEqual([
          { type: "rawKeyDown", keyCode: "Shift", modifiers: ["shift"] },
          { type: "keyUp", keyCode: "Shift", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Control", modifiers: ["control"] },
          { type: "keyUp", keyCode: "Control", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Alt", modifiers: ["alt"] },
          { type: "keyUp", keyCode: "Alt", modifiers: [] },
          { type: "rawKeyDown", keyCode: "Meta", modifiers: ["meta"] },
          { type: "keyUp", keyCode: "Meta", modifiers: [] },
          { type: "rawKeyDown", keyCode: "X", modifiers: [] },
          { type: "char", keyCode: "x", modifiers: [] },
          { type: "keyUp", keyCode: "X", modifiers: [] },
        ]);
        expect(guest.activity.filter((event) => event.startsWith("receipt:"))).toEqual(
          Array.from({ length: 5 }, () => ["receipt:down", "receipt:up"]).flat(),
        );
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual(
          Array.from({ length: 5 }, () => [[true], [false]]).flat(),
        );
        expect(hostSendInputEvent).not.toHaveBeenCalled();
        expect(guest.reload).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("quarantines a modifier press after a wrong DOM modifier receipt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostSendInputEvent = vi.fn();
        const hostWebContents = {
          sendInputEvent: hostSendInputEvent,
        } as unknown as Electron.WebContents;
        let sentWrongReceipt = false;
        let guest: ReturnType<typeof makeKeyboardWebContents>;
        guest = makeKeyboardWebContents({
          hostWebContents,
          onSendInputEvent: (packet) => {
            if (packet.type !== "rawKeyDown" || sentWrongReceipt) return;
            sentWrongReceipt = true;
            queueMicrotask(() => {
              guest.emitHumanInput({
                kind: "key",
                phase: "down",
                key: "Meta",
                code: "MetaLeft",
                meta: false,
                shift: false,
                control: false,
                alt: false,
              });
            });
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_modifier_receipt");
        yield* manager.registerWebview("tab_modifier_receipt", 42);

        const press = yield* manager
          .automationPress("tab_modifier_receipt", { key: "Meta" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 2);
        yield* TestClock.adjust(0);
        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(press))).toBe(true);

        const retry = yield* Effect.exit(
          manager.automationPress("tab_modifier_receipt", { key: "x" }),
        );
        expect(Exit.isFailure(retry)).toBe(true);
        if (Exit.isFailure(retry)) {
          expect(Option.getOrThrow(Cause.findErrorOption(retry.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(2);
        expect(hostSendInputEvent).not.toHaveBeenCalled();

        guest.emitNavigation();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("rejects keyboard input when a child frame owns focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({
          hostWebContents,
          sendCommand: async (method, params) => {
            if (method !== "Runtime.evaluate") return undefined;
            return {
              result: {
                value:
                  typeof params?.["expression"] === "string" &&
                  params["expression"].includes("document.activeElement?.tagName")
                    ? true
                    : { ok: true },
              },
            };
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_frame");
        yield* manager.registerWebview("tab_frame", 42);

        const exit = yield* Effect.exit(manager.automationPress("tab_frame", { key: "x" }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardFocusedFrameUnsupportedError",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("rechecks child-frame focus at the native send boundary", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let guest: ReturnType<typeof makeKeyboardWebContents>;
        guest = makeKeyboardWebContents({
          hostWebContents,
          onSetIgnoreMenuShortcuts: (ignore) => {
            if (ignore) guest.setFocusedFrame("child");
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_frame");
        yield* manager.registerWebview("tab_frame", 42);

        const exit = yield* Effect.exit(manager.automationPress("tab_frame", { key: "x" }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardFocusedFrameUnsupportedError",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("does not reuse physical key receipts from a child frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({
          hostWebContents,
          initialFocusedFrame: "child",
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_frame");
        yield* manager.registerWebview("tab_frame", 42);

        const physicalInput = (type: "keyDown" | "keyUp"): Electron.Input => ({
          type,
          key: "x",
          code: "KeyX",
          meta: false,
          shift: false,
          control: false,
          alt: false,
          modifiers: [],
          isAutoRepeat: false,
          isComposing: false,
          location: 0,
        });
        guest.emitPhysicalInput(physicalInput("keyDown"));
        guest.emitPhysicalInput(physicalInput("keyUp"));
        guest.setFocusedFrame("main");

        yield* manager.automationPress("tab_frame", { key: "x" });

        expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet.type)).toEqual([
          "rawKeyDown",
          "char",
          "keyUp",
        ]);
      }),
    ),
  );

  effectIt.effect("lets child-frame physical input interrupt an agent press", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let injectedPhysicalKey = false;
        let guest: ReturnType<typeof makeKeyboardWebContents>;
        guest = makeKeyboardWebContents({
          hostWebContents,
          onSetIgnoreMenuShortcuts: (ignore) => {
            if (!ignore || injectedPhysicalKey) return;
            injectedPhysicalKey = true;
            guest.setFocusedFrame("child");
            guest.emitPhysicalInput({
              type: "keyDown",
              key: "q",
              code: "KeyQ",
              meta: false,
              shift: false,
              control: false,
              alt: false,
              modifiers: [],
              isAutoRepeat: false,
              isComposing: false,
              location: 0,
            });
            guest.setFocusedFrame("main");
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_frame");
        yield* manager.registerWebview("tab_frame", 42);

        const exit = yield* Effect.exit(manager.automationPress("tab_frame", { key: "x" }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationControlInterruptedError",
            operation: "press",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates agent shortcuts and still handles later physical shortcuts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostSendInputEvent = vi.fn();
        const hostWebContents = {
          sendInputEvent: hostSendInputEvent,
        } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_shortcuts");
        yield* manager.registerWebview("tab_shortcuts", 42);

        yield* manager.automationPress("tab_shortcuts", { key: "k", modifiers: ["Meta"] });
        yield* manager.automationPress("tab_shortcuts", { key: "r", modifiers: ["Meta"] });
        expect(hostSendInputEvent).not.toHaveBeenCalled();
        expect(guest.reload).not.toHaveBeenCalled();

        const physicalPalette = guest.emitPhysicalInput({
          type: "keyDown",
          key: "k",
          code: "KeyK",
          meta: true,
          shift: false,
          control: false,
          alt: false,
          modifiers: ["meta"],
          isAutoRepeat: false,
          isComposing: false,
          location: 0,
        });
        const physicalRefresh = guest.emitPhysicalInput({
          type: "keyDown",
          key: "r",
          code: "KeyR",
          meta: true,
          shift: false,
          control: false,
          alt: false,
          modifiers: ["meta"],
          isAutoRepeat: false,
          isComposing: false,
          location: 0,
        });
        yield* Effect.yieldNow;

        expect(physicalPalette).toHaveBeenCalledOnce();
        expect(physicalRefresh).toHaveBeenCalledOnce();
        expect(hostSendInputEvent).toHaveBeenCalledWith({
          type: "keyDown",
          keyCode: "k",
          modifiers: ["meta"],
        });
        expect(guest.reload).toHaveBeenCalledOnce();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false], [true], [false]]);
      }),
    ),
  );

  effectIt.effect("does not accept an unmarked same-key press as an agent receipt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let injectedPhysicalKey = false;
        let guest: ReturnType<typeof makeKeyboardWebContents>;
        const physicalInput = (type: "keyDown" | "keyUp"): Electron.Input => ({
          type,
          key: "x",
          code: "KeyX",
          meta: false,
          shift: false,
          control: false,
          alt: false,
          modifiers: [],
          isAutoRepeat: false,
          isComposing: false,
          location: 0,
        });
        const physicalSignal = (phase: "down" | "up") => ({
          kind: "key" as const,
          phase,
          key: "x",
          code: "KeyX",
          meta: false,
          shift: false,
          control: false,
          alt: false,
        });
        guest = makeKeyboardWebContents({
          hostWebContents,
          onSetIgnoreMenuShortcuts: (ignore) => {
            if (!ignore || injectedPhysicalKey) return;
            injectedPhysicalKey = true;
            guest.emitPhysicalInput(physicalInput("keyDown"));
            guest.emitPhysicalInput(physicalInput("keyUp"));
            guest.emitHumanInput(physicalSignal("down"));
            guest.emitHumanInput(physicalSignal("up"));
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const exit = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationControlInterruptedError",
            operation: "press",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("fails clearly when native keyboard delivery is unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let focused = false;
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => focused,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const unfocused = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));
        expect(Exit.isFailure(unfocused)).toBe(true);
        if (Exit.isFailure(unfocused)) {
          expect(Option.getOrThrow(Cause.findErrorOption(unfocused.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardWindowNotFocusedError",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();

        focused = true;
        guest.setConfirmDelivery(false);
        const unconfirmed = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        yield* TestClock.adjust(1_000);
        const unconfirmedExit = yield* Fiber.join(unconfirmed);
        expect(Exit.isFailure(unconfirmedExit)).toBe(true);
        if (Exit.isFailure(unconfirmedExit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(unconfirmedExit.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true]]);

        const sentPackets = guest.sendInputEvent.mock.calls.length;
        const quarantined = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));
        expect(Exit.isFailure(quarantined)).toBe(true);
        if (Exit.isFailure(quarantined)) {
          expect(Option.getOrThrow(Cause.findErrorOption(quarantined.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(sentPackets);

        const physicalKey = guest.emitPhysicalInput({
          type: "keyDown",
          key: "a",
          code: "KeyA",
          meta: false,
          shift: false,
          control: false,
          alt: false,
          modifiers: [],
          isAutoRepeat: false,
          isComposing: false,
          location: 0,
        });
        expect(physicalKey).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("restores menu shortcuts when raw key-down dispatch throws", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failDispatch = true;
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({
          hostWebContents,
          onSendInputEvent: (packet) => {
            if (failDispatch && packet.type === "rawKeyDown") {
              failDispatch = false;
              throw new Error("dispatch failed");
            }
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const failed = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet.type)).toEqual([
          "rawKeyDown",
        ]);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);

        yield* manager.automationPress("tab_input", { key: "x" });
        expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet.type)).toEqual([
          "rawKeyDown",
          "rawKeyDown",
          "char",
          "keyUp",
        ]);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false], [true], [false]]);
      }),
    ),
  );

  effectIt.effect("recovers uncertain keyboard delivery only after committed navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const failed = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(failed))).toBe(true);

        guest.emitNavigationStarted();
        guest.emitInPageNavigation();
        for (const key of ["y", "z"] as const) {
          const blocked = yield* Effect.exit(manager.automationPress("tab_input", { key }));
          expect(Exit.isFailure(blocked)).toBe(true);
        }
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true]]);

        guest.emitNavigation();
        guest.setConfirmDelivery(true);
        yield* manager.automationPress("tab_input", { key: "y" });

        expect(guest.sendInputEvent).toHaveBeenCalledTimes(6);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false], [true], [false]]);
      }),
    ),
  );

  effectIt.effect("rejects stale and non-main-frame receipts after navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const oldPress = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        yield* TestClock.adjust(1_000);
        yield* Fiber.join(oldPress);
        guest.emitNavigation();

        const currentPress = yield* manager
          .automationPress("tab_input", { key: "y" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 6);
        const down = makeKeyboardSignal("down", "y");
        const up = makeKeyboardSignal("up", "y");
        guest.emitHumanInput(down, { processId: 100, frameId: 200 });
        guest.emitHumanInput(down, { frame: null });
        guest.emitHumanInput(down, { frame: "child" });
        guest.emitHumanInput(down, { processId: 999 });
        guest.setMainFrameDetached(true);
        guest.emitHumanInput(down);
        guest.setMainFrameDetached(false);
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        expect(currentPress.pollUnsafe()).toBeUndefined();

        guest.emitHumanInput(down);
        guest.emitHumanInput(up);
        expect(Exit.isSuccess(yield* Fiber.join(currentPress))).toBe(true);
      }),
    ),
  );

  effectIt.effect("does not quarantine a new document for an old key receipt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let reportKeyUp: (() => void) | undefined;
        const keyUpSent = new Promise<void>((resolve) => {
          reportKeyUp = resolve;
        });
        const guest = makeKeyboardWebContents({
          hostWebContents,
          onSendInputEvent: (packet) => {
            if (packet.type === "keyUp") reportKeyUp?.();
          },
        });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_navigation_receipt");
        yield* manager.registerWebview("tab_navigation_receipt", 42);

        const oldPress = yield* manager
          .automationPress("tab_navigation_receipt", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => keyUpSent);

        guest.emitNavigation();
        guest.emitHumanInput(makeKeyboardSignal("up", "x"));
        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(oldPress))).toBe(true);

        guest.setConfirmDelivery(true);
        yield* manager.automationPress("tab_navigation_receipt", { key: "y" });
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(6);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false], [true], [false]]);
      }),
    ),
  );

  effectIt.effect("quarantines a document after a partial out-of-order receipt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationEvaluate("tab_input", { expression: "1" });

        const press = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(press))).toBe(true);

        const sentPackets = guest.sendInputEvent.mock.calls.length;
        const retry = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));
        expect(Exit.isFailure(retry)).toBe(true);
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(sentPackets);
      }),
    ),
  );

  effectIt.effect("hands menu ownership to physical input while a press waits", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationEvaluate("tab_input", { expression: "1" });

        const press = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true]]);

        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "q"));
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(press))).toBe(true);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("keeps a delayed physical receipt ahead of a same-key agent receipt", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationEvaluate("tab_input", { expression: "1" });

        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "x"));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        const press = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);

        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        expect(press.pollUnsafe()).toBeUndefined();
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        guest.emitHumanInput(makeKeyboardSignal("up", "x"));

        expect(Exit.isSuccess(yield* Fiber.join(press))).toBe(true);
      }),
    ),
  );

  effectIt.effect("does not queue prevented shortcuts or completed physical keys", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostSendInputEvent = vi.fn();
        const hostWebContents = {
          sendInputEvent: hostSendInputEvent,
        } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "k", { meta: true }));
        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "r", { meta: true }));
        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "x"));
        guest.emitPhysicalInput(makeKeyboardInput("keyUp", "x"));
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        guest.emitHumanInput(makeKeyboardSignal("up", "x"));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;

        yield* manager.automationPress("tab_input", { key: "k", modifiers: ["Meta"] });
        yield* manager.automationPress("tab_input", { key: "r", modifiers: ["Meta"] });
        yield* manager.automationPress("tab_input", { key: "x" });

        expect(hostSendInputEvent).toHaveBeenCalledOnce();
        expect(guest.reload).toHaveBeenCalledOnce();
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(7);
      }),
    ),
  );

  effectIt.effect("keeps an agent FIFO after an orphaned physical key-down", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "x"));
        guest.emitPhysicalInput(makeKeyboardInput("keyUp", "x"));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        const press = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);

        guest.emitHumanInput(makeKeyboardSignal("up", "x"));
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        guest.emitHumanInput(makeKeyboardSignal("up", "x"));

        expect(Exit.isSuccess(yield* Fiber.join(press))).toBe(true);
      }),
    ),
  );

  effectIt.effect("quarantines keyboard delivery after the physical FIFO overflows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        for (let index = 0; index < 21; index++) {
          guest.emitPhysicalInput(makeKeyboardInput("keyDown", "x"));
        }

        const exit = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps an unconfirmed post-dispatch replacement as a delivery failure", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let currentWebContents: Electron.WebContents;
        const first = makeKeyboardWebContents({
          hostWebContents,
          onSendInputEvent: (packet) => {
            if (packet.type === "keyUp") currentWebContents = replacement.webContents;
          },
        });
        first.setConfirmDelivery(false);
        currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const press = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => first.sendInputEvent.mock.calls.length === 3);
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.join(press);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
      }),
    ),
  );

  effectIt.effect("keeps a stale press finalizer away from a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const first = makeKeyboardWebContents({ hostWebContents });
        const replacement = makeKeyboardWebContents({ hostWebContents });
        first.setConfirmDelivery(false);
        let currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationEvaluate("tab_input", { expression: "1" });

        const stalePress = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => first.sendInputEvent.mock.calls.length === 3);
        expect(first.setIgnoreMenuShortcuts.mock.calls).toEqual([[true]]);

        currentWebContents = replacement.webContents;
        yield* manager.registerWebview("tab_input", 42);
        expect(first.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
        expect(replacement.setIgnoreMenuShortcuts).not.toHaveBeenCalled();

        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(stalePress))).toBe(true);
        expect(first.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
        expect(replacement.setIgnoreMenuShortcuts).not.toHaveBeenCalled();

        yield* manager.automationPress("tab_input", { key: "y" });
        expect(replacement.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("keeps keyboard input isolated to the selected guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const first = makeKeyboardWebContents({ hostWebContents, id: 41 });
        const second = makeKeyboardWebContents({ hostWebContents, id: 42 });
        const webContentsById = new Map([
          [41, first.webContents],
          [42, second.webContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_first");
        yield* manager.createTab("tab_second");
        yield* manager.registerWebview("tab_first", 41);
        yield* manager.registerWebview("tab_second", 42);

        yield* Effect.all(
          [
            manager.automationPress("tab_first", { key: "x" }),
            manager.automationPress("tab_second", { key: "y" }),
          ],
          { concurrency: 2, discard: true },
        );

        expect(first.sendInputEvent).toHaveBeenCalledTimes(3);
        expect(second.sendInputEvent).toHaveBeenCalledTimes(3);
        expect(first.focus).not.toHaveBeenCalled();
        expect(second.focus).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("transfers a reused WebContents ID to one tab owner", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_first");
        yield* manager.createTab("tab_second");
        yield* manager.registerWebview("tab_first", 42);
        yield* manager.registerWebview("tab_second", 42);

        const oldOwner = yield* Effect.exit(manager.automationPress("tab_first", { key: "x" }));
        expect(Exit.isFailure(oldOwner)).toBe(true);
        expect(guest.sendInputEvent).not.toHaveBeenCalled();

        const detachCount = guest.off.mock.calls.length;
        yield* manager.closeTab("tab_first");
        expect(guest.off).toHaveBeenCalledTimes(detachCount);

        yield* manager.automationPress("tab_second", { key: "y" });
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("preserves keyboard quarantine when the same WebContents changes owners", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        guest.setConfirmDelivery(false);
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_first");
        yield* manager.createTab("tab_second");
        yield* manager.registerWebview("tab_first", 42);
        yield* manager.automationEvaluate("tab_first", { expression: "1" });

        const stalePress = yield* manager
          .automationPress("tab_first", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* settle(() => guest.sendInputEvent.mock.calls.length === 3);
        yield* manager.registerWebview("tab_second", 42);
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);

        const assertQuarantined = Effect.fn(function* () {
          const exit = yield* Effect.exit(manager.automationPress("tab_second", { key: "x" }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
            });
          }
          expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
        });

        yield* assertQuarantined();
        guest.emitHumanInput(makeKeyboardSignal("down", "x"));
        guest.emitHumanInput(makeKeyboardSignal("up", "x"));
        yield* assertQuarantined();

        yield* TestClock.adjust(1_000);
        expect(Exit.isFailure(yield* Fiber.join(stalePress))).toBe(true);
        yield* assertQuarantined();

        guest.emitNavigation();
        guest.setConfirmDelivery(true);
        yield* manager.automationPress("tab_second", { key: "y" });
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(6);
      }),
    ),
  );

  effectIt.effect("preserves a physical receipt hazard across detached WebContents reuse", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({ hostWebContents });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_first");
        yield* manager.registerWebview("tab_first", 42);

        guest.emitPhysicalInput(makeKeyboardInput("keyDown", "x"));
        yield* manager.closeTab("tab_first");
        yield* manager.createTab("tab_second");
        yield* manager.registerWebview("tab_second", 42);

        const blocked = yield* Effect.exit(manager.automationPress("tab_second", { key: "x" }));
        expect(Exit.isFailure(blocked)).toBe(true);
        if (Exit.isFailure(blocked)) {
          expect(Option.getOrThrow(Cause.findErrorOption(blocked.cause))).toMatchObject({
            _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();

        guest.emitNavigation();
        yield* manager.automationPress("tab_second", { key: "y" });
        expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("rejects a same-id guest replacement while keyboard input is queued", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let startBlockedEvaluate = false;
        let releaseEvaluate: (() => void) | undefined;
        let reportEvaluateStarted: (() => void) | undefined;
        const evaluateStarted = new Promise<void>((resolve) => {
          reportEvaluateStarted = resolve;
        });
        const evaluateRelease = new Promise<void>((resolve) => {
          releaseEvaluate = resolve;
        });
        const first = makeKeyboardWebContents({
          hostWebContents,
          sendCommand: async (method) => {
            if (method === "Runtime.evaluate" && startBlockedEvaluate) {
              reportEvaluateStarted?.();
              await evaluateRelease;
              return { result: { value: { ok: true } } };
            }
            return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
          },
        });
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        startBlockedEvaluate = true;
        const active = yield* manager
          .automationEvaluate("tab_input", { expression: "blocked" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => evaluateStarted);
        const queued = yield* manager
          .automationPress("tab_input", { key: "y" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;

        currentWebContents = replacement.webContents;
        yield* manager.registerWebview("tab_input", 42);
        releaseEvaluate?.();
        yield* Fiber.join(active);
        const queuedExit = yield* Fiber.join(queued);

        expect(Exit.isFailure(queuedExit)).toBe(true);
        if (Exit.isFailure(queuedExit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(queuedExit.cause))).toMatchObject({
            _tag: "PreviewAutomationTargetChangedError",
            operation: "press",
            tabId: "tab_input",
            webContentsId: 42,
          });
        }
        expect(first.sendInputEvent).not.toHaveBeenCalled();
        expect(replacement.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("rechecks a same-id replacement at the native send boundary", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let currentWebContents: Electron.WebContents;
        const first = makeKeyboardWebContents({
          hostWebContents,
          onSetIgnoreMenuShortcuts: (ignore) => {
            if (ignore) currentWebContents = replacement.webContents;
          },
        });
        currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const exit = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationTargetChangedError",
            operation: "press",
            tabId: "tab_input",
            webContentsId: 42,
          });
        }
        expect(first.sendInputEvent).not.toHaveBeenCalled();
        expect(replacement.sendInputEvent).not.toHaveBeenCalled();
        expect(first.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect("does not publish a stale control session after a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let releaseInitialization: (() => void) | undefined;
        let reportInitializationStarted: (() => void) | undefined;
        const initializationStarted = new Promise<void>((resolve) => {
          reportInitializationStarted = resolve;
        });
        const initializationRelease = new Promise<void>((resolve) => {
          releaseInitialization = resolve;
        });
        let blockInitialization = true;
        const first = makeKeyboardWebContents({
          hostWebContents,
          sendCommand: async (method, params) => {
            if (method === "Runtime.enable" && blockInitialization) {
              reportInitializationStarted?.();
              await initializationRelease;
              blockInitialization = false;
              return undefined;
            }
            if (method !== "Runtime.evaluate") return undefined;
            return {
              result: {
                value:
                  typeof params?.["expression"] === "string" &&
                  params["expression"].includes("document.activeElement?.tagName")
                    ? false
                    : { ok: true },
              },
            };
          },
        });
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* Effect.promise(() => initializationStarted);

        currentWebContents = replacement.webContents;
        const registration = yield* manager
          .registerWebview("tab_input", 42)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* settle(() => first.off.mock.calls.length > 0);
        expect(first.off).toHaveBeenCalled();
        releaseInitialization?.();
        yield* Fiber.join(registration);

        yield* manager.automationPress("tab_input", { key: "x" });

        expect(first.sendInputEvent).not.toHaveBeenCalled();
        expect(replacement.sendInputEvent).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("does not open DevTools on a stale same-id guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let currentWebContents: Electron.WebContents;
        let replaceOnDevToolsCheck = false;
        const first = makeKeyboardWebContents({
          hostWebContents,
          onIsDevToolsOpened: () => {
            if (replaceOnDevToolsCheck) currentWebContents = replacement.webContents;
          },
        });
        currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationEvaluate("tab_input", { expression: "1" });

        replaceOnDevToolsCheck = true;
        const exit = yield* Effect.exit(manager.openDevTools("tab_input"));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationTargetChangedError",
            operation: "openDevTools",
          });
        }
        expect(first.openDevTools).not.toHaveBeenCalled();
        expect(replacement.openDevTools).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("finalizes the action timeline when control setup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        const guest = makeKeyboardWebContents({
          hostWebContents,
          initialDevToolsOpened: true,
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const failed = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));
        expect(Exit.isFailure(failed)).toBe(true);

        guest.setDevToolsOpened(false);
        const snapshot = yield* manager.automationSnapshot("tab_input");
        expect(snapshot.actionTimeline.find((event) => event.action === "press")).toMatchObject({
          action: "press",
          status: "failed",
          error: "Close preview DevTools before using agent browser control for WebContents 42",
        });
      }),
    ),
  );

  effectIt.effect("does not dispatch a key after a human pointer claims control", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let pointerInjected = false;
        let guest: ReturnType<typeof makeKeyboardWebContents>;
        guest = makeKeyboardWebContents({
          hostWebContents,
          onSetIgnoreMenuShortcuts: (ignore) => {
            if (!ignore || pointerInjected) return;
            pointerInjected = true;
            guest.emitHumanInput({ kind: "pointer", x: 12, y: 24, button: 0 });
          },
        });
        fromId.mockReturnValue(guest.webContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_pointer_before_key");
        yield* manager.registerWebview("tab_pointer_before_key", 42);

        const exit = yield* Effect.exit(
          manager.automationPress("tab_pointer_before_key", { key: "x" }),
        );
        yield* TestClock.adjust(750);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewAutomationControlInterruptedError",
            operation: "press",
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
        expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
      }),
    ),
  );

  effectIt.effect(
    "does not complete a key press after a pointer claims control between receipts",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
          let reportKeyUp: (() => void) | undefined;
          const keyUpSent = new Promise<void>((resolve) => {
            reportKeyUp = resolve;
          });
          const guest = makeKeyboardWebContents({
            hostWebContents,
            onSendInputEvent: (packet) => {
              if (packet.type === "keyUp") reportKeyUp?.();
            },
          });
          guest.setConfirmDelivery(false);
          fromId.mockReturnValue(guest.webContents);
          let humanHasControl = false;
          yield* manager.subscribeStateChanges((_tabId, state) =>
            Effect.sync(() => {
              if (state.controller === "human") humanHasControl = true;
            }),
          );
          yield* manager.setMainWindow({
            isDestroyed: () => false,
            isFocused: () => true,
            once: vi.fn(),
            webContents: hostWebContents,
          } as never);
          yield* manager.createTab("tab_pointer_receipts");
          yield* manager.registerWebview("tab_pointer_receipts", 42);

          const press = yield* manager
            .automationPress("tab_pointer_receipts", { key: "x" })
            .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => keyUpSent);
          guest.emitHumanInput(makeKeyboardSignal("down", "x"));
          yield* TestClock.adjust(0);

          guest.emitHumanInput({ kind: "pointer", x: 12, y: 24, button: 0 });
          yield* settle(() => humanHasControl);
          guest.emitHumanInput(makeKeyboardSignal("up", "x"));
          yield* TestClock.adjust(0);
          yield* TestClock.adjust(1_000);

          const exit = yield* Fiber.join(press);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "PreviewAutomationControlInterruptedError",
              operation: "press",
            });
          }
          expect(guest.sendInputEvent.mock.calls.map(([packet]) => packet.type)).toEqual([
            "rawKeyDown",
            "char",
            "keyUp",
          ]);

          guest.emitNavigation();
          expect(guest.setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
        }),
      ),
  );

  effectIt.effect("rejects queued keyboard input after physical input takes control", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let releaseEvaluate: (() => void) | undefined;
        let reportEvaluateStarted: (() => void) | undefined;
        const evaluateStarted = new Promise<void>((resolve) => {
          reportEvaluateStarted = resolve;
        });
        const evaluateRelease = new Promise<void>((resolve) => {
          releaseEvaluate = resolve;
        });
        const guest = makeKeyboardWebContents({
          hostWebContents,
          sendCommand: async (method, params) => {
            if (method === "Runtime.evaluate" && params?.["expression"] === "blocked") {
              reportEvaluateStarted?.();
              await evaluateRelease;
              return { result: { value: { ok: true } } };
            }
            return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
          },
        });
        fromId.mockReturnValue(guest.webContents);
        let humanHasControl = false;
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            if (state.controller === "human") humanHasControl = true;
          }),
        );
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const active = yield* manager
          .automationEvaluate("tab_input", { expression: "blocked" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => evaluateStarted);
        const queued = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        for (let attempt = 0; attempt < 3; attempt++) yield* Effect.yieldNow;
        guest.emitHumanInput({ kind: "pointer", x: 12, y: 24, button: 0 });
        yield* settle(() => humanHasControl);
        releaseEvaluate?.();
        yield* Fiber.join(active);
        const queuedExit = yield* Fiber.join(queued);

        expect(Exit.isFailure(queuedExit)).toBe(true);
        if (Exit.isFailure(queuedExit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(queuedExit.cause))).toMatchObject({
            _tag: "PreviewAutomationControlInterruptedError",
            operation: "press",
            tabId: "tab_input",
            webContentsId: 42,
          });
        }
        expect(guest.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not release a failed key into a replacement document", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const hostWebContents = { sendInputEvent: vi.fn() } as unknown as Electron.WebContents;
        let currentWebContents: Electron.WebContents;
        const replacement = makeKeyboardWebContents({ hostWebContents });
        let failKeyDown = true;
        const first = makeKeyboardWebContents({
          hostWebContents,
          onSendInputEvent: (packet) => {
            if (packet.type !== "rawKeyDown" || !failKeyDown) return;
            failKeyDown = false;
            currentWebContents = replacement.webContents;
            throw new Error("native key dispatch failed");
          },
        });
        currentWebContents = first.webContents;
        fromId.mockImplementation(() => currentWebContents);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);

        const failed = yield* Effect.exit(manager.automationPress("tab_input", { key: "x" }));

        expect(Exit.isFailure(failed)).toBe(true);
        expect(first.sendInputEvent.mock.calls.map(([packet]) => packet.type)).toEqual([
          "rawKeyDown",
        ]);
        expect(replacement.sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const mainFrame = {
          detached: false,
          processId: 100,
          routingId: 200,
        } as Electron.WebFrameMain;
        let guestWebContents: Electron.WebContents;
        let humanInput: ((event: Electron.IpcMainEvent, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.(
              {
                sender: guestWebContents,
                senderFrame: mainFrame,
                processId: mainFrame.processId,
                frameId: mainFrame.routingId,
              } as Electron.IpcMainEvent,
              { kind: "pointer", x: 400, y: 300, button: 0 },
            );
          }
          return undefined;
        });
        guestWebContents = {
          id: 42,
          mainFrame,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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
        } as never;
        fromId.mockReturnValue(guestWebContents);

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
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
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
