import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import type { PortalShortcutState } from "./PortalCaptureShortcut.ts";
import { beforeEach, vi } from "vite-plus/test";

beforeEach(() => {
  portalShortcutInstances.length = 0;
  nextPortalState.value = undefined;
  vi.stubEnv("NIRI_SOCKET", "");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "test-desktop");
  transitionCapturePageMock.mockReset().mockResolvedValue(undefined);
  transitionSnapshotMock.mockReset().mockResolvedValue(undefined);
  prepareCaptureRevealMock.mockReset();
});

const {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessWarmMock,
  accessibilityProcessCloseMock,
  accessibilityProcessCoolMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityForegroundMock,
  accessibilityTrustedMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getFileIconMock,
  getSourcesMock,
  macCaptureMock,
  linuxCaptureMock,
  linuxBackendMock,
  niriShortcutMock,
  niriShortcutStopMock,
  mediaAccessStatusMock,
  openExternalMock,
  registerShortcutMock,
  unregisterShortcutMock,
  portalShortcutInstances,
  prepareCaptureRevealMock,
  nextPortalState,
  regionCaptureMock,
  screenToDipRectMock,
  shortcutForkArgs,
  shortcutForkOptions,
  shortcutProcesses,
  spawnedPollers,
  thumbnailFromPathMock,
  transitionCapturePageMock,
  transitionScriptState,
  transitionShowMock,
  transitionSnapshotMock,
} = vi.hoisted(() => ({
  activeWindowMock: vi.fn(),
  animationSettingsMock: vi.fn(() => ({
    prefersReducedMotion: true,
    shouldRenderRichAnimation: false,
  })),
  accessibilityProcessWarmMock: vi.fn(),
  accessibilityProcessCloseMock: vi.fn(),
  accessibilityProcessCoolMock: vi.fn(),
  accessibilityProcessReadMock: vi.fn<
    (request: import("./SnapShotAccessibility.ts").SnapShotAccessibilityRequest) => {
      started: Promise<void>;
      result: Promise<
        import("./SnapShotAccessibility.ts").CapturedWindowAccessibilityContext | undefined
      >;
    }
  >(),
  accessibilityByPidMock: vi.fn(),
  accessibilityForegroundMock: vi.fn(),
  accessibilityTrustedMock: vi.fn((_prompt = false) => true),
  allWindowsMock: vi.fn(
    () =>
      [] as Array<{
        getBounds: () => Electron.Rectangle;
        isDestroyed: () => boolean;
      }>,
  ),
  flashWindows: [] as Array<{
    bounds: Electron.Rectangle | null;
    destroyed: boolean;
    kind: "base" | "browser";
    loadCount: number;
    loadedUrls: Array<string>;
    opacities: Array<number>;
    options: Electron.BrowserWindowConstructorOptions;
    scripts: Array<string>;
    capturedRegions: Array<Electron.Rectangle>;
    showCount: number;
    resizeCount: number;
    alwaysOnTopCalls: Array<[boolean, string | undefined]>;
  }>,
  focusedWindowMock: vi.fn(),
  getFileIconMock: vi.fn(),
  getSourcesMock: vi.fn(),
  macCaptureMock: vi.fn(),
  linuxCaptureMock: vi.fn<
    () => Promise<import("./LinuxSnapShot.ts").LinuxWindowSnapshot | undefined>
  >(async () => undefined),
  linuxBackendMock: vi.fn(async () => "picker"),
  niriShortcutStopMock: vi.fn(),
  niriShortcutMock:
    vi.fn<(appId: string, trigger: () => void, fail: () => void) => Promise<() => void>>(),
  mediaAccessStatusMock: vi.fn(() => "not-determined"),
  openExternalMock: vi.fn(() => Promise.resolve()),
  registerShortcutMock: vi.fn(),
  unregisterShortcutMock: vi.fn(),
  nextPortalState: { value: undefined as PortalShortcutState | undefined },
  portalShortcutInstances: [] as Array<{
    state: PortalShortcutState;
    onCapture: () => Promise<void>;
    onStateChanged: () => void;
    close: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
    hasSession: boolean;
  }>,
  prepareCaptureRevealMock: vi.fn(),
  regionCaptureMock:
    vi.fn<
      (region: Electron.Rectangle) => Promise<{ width: number; height: number; png: Buffer }>
    >(),
  screenToDipRectMock: vi.fn((_window: unknown, bounds: Electron.Rectangle) => bounds),
  shortcutForkArgs: [] as Array<ReadonlyArray<string>>,
  shortcutForkOptions: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  shortcutProcesses: [] as Array<{
    emit: (event: string, value?: unknown) => void;
    kill: ReturnType<typeof vi.fn>;
    on: (event: string, listener: (value: unknown) => void) => unknown;
    once: (event: string, listener: (value: unknown) => void) => unknown;
  }>,
  spawnedPollers: [] as Array<{
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
  thumbnailFromPathMock: vi.fn(),
  transitionCapturePageMock: vi.fn<() => Promise<void>>(),
  transitionScriptState: {
    rejectFlight: false,
    heldFlights: null as Array<() => void> | null,
  },
  transitionShowMock: vi.fn(),
  transitionSnapshotMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("./SnapShotAccessibilityProcess.ts", () => ({
  makeSnapShotAccessibilityProcessPool: () => ({
    warm: accessibilityProcessWarmMock,
    cool: accessibilityProcessCoolMock,
    read: accessibilityProcessReadMock,
    close: accessibilityProcessCloseMock,
  }),
}));
vi.mock("./ActiveWindow.ts", () => ({ activeWindow: activeWindowMock }));
vi.mock("./RegionSnapShot.ts", async (original) => ({
  ...(await original<typeof import("./RegionSnapShot.ts")>()),
  makeRegionSnapShotPool: () => ({
    warm: vi.fn(),
    cool: vi.fn(),
    close: vi.fn(),
    capture: regionCaptureMock,
  }),
}));
vi.mock("./WindowsCaptureFeedback.ts", () => ({
  showWindowsCaptureOverlay: (window: Electron.BaseWindow) => window.showInactive(),
}));
vi.mock("./MacSnapShot.ts", () => ({ captureMacWindowSnapshot: macCaptureMock }));
vi.mock("./LinuxSnapShot.ts", () => ({
  captureLinuxWindow: linuxCaptureMock,
  getLinuxCaptureSupport: async () => ({
    linuxBackend: await linuxBackendMock(),
    linuxFeedbackAvailable: false,
  }),
}));
vi.mock("./NiriCaptureShortcut.ts", async (original) => ({
  ...(await original<typeof import("./NiriCaptureShortcut.ts")>()),
  startNiriCaptureShortcut: niriShortcutMock,
}));
vi.mock("./PortalCaptureShortcut.ts", async (original) => ({
  ...(await original<typeof import("./PortalCaptureShortcut.ts")>()),
  PortalCaptureShortcut: class {
    state: PortalShortcutState = nextPortalState.value ?? {
      shortcutRegistered: true,
      shortcutPending: false,
      shortcutLabel: "Ctrl+Shift+2",
      shortcutMessage: "Desktop shortcut: Ctrl+Shift+2",
    };
    close = vi.fn();
    configure = vi.fn(async () => {});
    hasSession = true;
    onCapture: () => Promise<void>;
    onStateChanged: () => void;
    constructor(
      _appId: string,
      _shortcut: unknown,
      onCapture: () => Promise<void>,
      onStateChanged: () => void,
    ) {
      this.onCapture = onCapture;
      this.onStateChanged = onStateChanged;
      portalShortcutInstances.push(this);
    }
  },
}));
vi.mock("node:child_process", () => ({
  spawn: (_command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    queueMicrotask(() => record.emitStderr("ready\n"));
    return child;
  },
  fork: (_path: string, args: ReadonlyArray<string>, options: { env?: NodeJS.ProcessEnv }) => {
    const listeners = new Map<string, Array<(value: unknown) => void>>();
    const process = {
      emit: (event: string, value?: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      kill: vi.fn(() => true),
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return process;
      },
      once: (event: string, listener: (value: unknown) => void) => {
        const wrapped = (value: unknown) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
          );
          listener(value);
        };
        listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
        return process;
      },
    };
    shortcutForkArgs.push(args);
    shortcutForkOptions.push(options);
    shortcutProcesses.push(process);
    queueMicrotask(() => process.emit("message", "ready"));
    return process;
  },
}));
vi.mock("electron", () => {
  class BaseWindow {
    protected readonly state: (typeof flashWindows)[number];

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = {
        bounds:
          options.x === undefined ||
          options.y === undefined ||
          options.width === undefined ||
          options.height === undefined
            ? null
            : { x: options.x, y: options.y, width: options.width, height: options.height },
        destroyed: false,
        kind: "base",
        loadCount: 0,
        loadedUrls: [],
        opacities: options.opacity === undefined ? [] : [options.opacity],
        options,
        scripts: [],
        capturedRegions: [],
        showCount: 0,
        resizeCount: 0,
        alwaysOnTopCalls: [],
      };
      flashWindows.push(this.state);
    }

    destroy() {
      this.state.destroyed = true;
    }

    getBounds() {
      return this.state.bounds;
    }

    isDestroyed() {
      return this.state.destroyed;
    }

    setBounds(bounds: Electron.Rectangle) {
      this.state.resizeCount++;
      this.state.bounds = bounds;
    }

    setIgnoreMouseEvents() {}

    setOpacity(opacity: number) {
      this.state.opacities.push(opacity);
    }

    setAlwaysOnTop(flag: boolean, level?: string) {
      this.state.alwaysOnTopCalls.push([flag, level]);
    }

    showInactive() {
      const shownBounds = transitionShowMock(this.state.bounds);
      if (shownBounds !== undefined) this.state.bounds = shownBounds;
      this.state.showCount += 1;
    }
  }

  class BrowserWindow extends BaseWindow {
    static getFocusedWindow() {
      return focusedWindowMock();
    }

    static getAllWindows() {
      return allWindowsMock();
    }

    readonly webContents;

    constructor(options: Electron.BrowserWindowConstructorOptions) {
      super(options);
      this.state.kind = "browser";
      this.webContents = {
        executeJavaScript: async (script: string) => {
          this.state.scripts.push(script);
          if (script.startsWith("window.setCaptureSnapshot")) {
            await transitionSnapshotMock();
          }
          if (script !== "window.playCaptureTransition()") return;
          if (transitionScriptState.rejectFlight) {
            transitionScriptState.rejectFlight = false;
            throw new Error("transition failed");
          }
          const held = transitionScriptState.heldFlights;
          if (held) await new Promise<void>((resolve) => held.push(resolve));
        },
        capturePage: async (bounds: Electron.Rectangle) => {
          this.state.capturedRegions.push(bounds);
          await transitionCapturePageMock();
        },
      };
    }

    loadURL(url: string) {
      this.state.loadCount += 1;
      this.state.loadedUrls.push(url);
      return Promise.resolve();
    }
  }

  return {
    BaseWindow,
    BrowserWindow,
    app: { getFileIcon: getFileIconMock },
    desktopCapturer: { getSources: getSourcesMock },
    nativeImage: { createThumbnailFromPath: thumbnailFromPathMock },
    globalShortcut: { register: registerShortcutMock, unregister: unregisterShortcutMock },
    screen: {
      getDisplayMatching: (bounds: Electron.Rectangle) =>
        bounds.x < 0
          ? { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } }
          : { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      getAllDisplays: () => [
        { id: 1, bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
        { id: 2, bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
      ],
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1_440, height: 900 } }),
      screenToDipRect: screenToDipRectMock,
    },
    shell: { openExternal: openExternalMock },
    systemPreferences: {
      getAnimationSettings: () => animationSettingsMock(),
      getMediaAccessStatus: () => mediaAccessStatusMock(),
      isTrustedAccessibilityClient: (prompt: boolean) => accessibilityTrustedMock(prompt),
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "./DesktopSnapShot.ts";
import * as SnapShotAccessibility from "./SnapShotAccessibility.ts";

// The accessibility reader normally runs in a worker with the real xa11y `App`.
// Tests hand it this stand-in so the mocks above drive window lookups.
const accessibilityApp = {
  byPid: accessibilityByPidMock,
  foreground: accessibilityForegroundMock,
} as unknown as Parameters<typeof SnapShotAccessibility.readAccessibleWindowContextWithApp>[0];
const readAccessibleWindowContext = (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  platform: NodeJS.Platform,
  sourceTitle: string,
  imageSize: Electron.Size = {
    width: Math.max(1, Math.round(active.bounds.width)),
    height: Math.max(1, Math.round(active.bounds.height)),
  },
) =>
  SnapShotAccessibility.readAccessibleWindowContextWithApp(accessibilityApp, {
    active,
    platform,
    sourceTitle,
    imageSize,
  });
const readAccessibleWindowText = async (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  platform: NodeJS.Platform,
  sourceTitle: string,
) => (await readAccessibleWindowContext(active, platform, sourceTitle))?.accessibleText;
accessibilityProcessReadMock.mockImplementation((request) => ({
  started: Promise.resolve(),
  result: readAccessibleWindowContext(
    request.active,
    request.platform,
    request.sourceTitle,
    request.imageSize,
  ),
}));
vi.mock("./GnomeCaptureSetup.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./GnomeCaptureSetup.ts")>()),
  GnomeCaptureSetup: class {
    state = async () => ({ status: "enabled" as const, message: "Extension running" });
    perform = async () => undefined;
    close = () => undefined;
  },
}));

const decodePendingMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPendingSnapShot),
);

import {
  SnapShotTransition,
  snapShotAnimationDurationMs,
  snapShotAnimationDisplayBounds,
  snapShotAnimationOverlayBounds,
} from "./SnapShotTransition.ts";
const testLayer = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
  settingsGet: Effect.Effect<
    Option.Option<ClientSettings>,
    DesktopClientSettings.DesktopClientSettingsReadError
  > = Effect.succeed(initialSettings),
) =>
  Layer.mergeAll(
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        platform,
        stateDir: "/state",
        linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
        appRoot: "/repo",
        linuxApplicationsDir: "/test-data/applications",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.succeed(
      DesktopClientSettings.DesktopClientSettings,
      DesktopClientSettings.DesktopClientSettings.of({
        get: settingsGet,
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: Effect.void,
        prepareCaptureReveal: Effect.sync(prepareCaptureRevealMock),
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: () => Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    FileSystem.layerNoop(fileSystemOverrides),
    Path.layer,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

const enabledSettings = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  snapShotEnabled: true,
  ...overrides,
});

function concurrentCaptureFixture(platform: NodeJS.Platform, animations: boolean) {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([]);
  registerShortcutMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  animationSettingsMock.mockReturnValue({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  flashWindows.length = 0;
  const captures = ["Discord", "File Explorer", "Terminal"].map((title, index) => ({
    title,
    id: index + 42,
    processId: index + 100,
    png: Buffer.from([index, index + 1, index + 2]),
    started: Promise.withResolvers<void>(),
    pixels: Promise.withResolvers<void>(),
    handoff: Promise.withResolvers<void>(),
    context: Promise.withResolvers<SnapShotAccessibility.CapturedWindowAccessibilityContext>(),
    oldOverlaysCleared: false,
    oldNativeFeedbackClosed: false,
    feedback: {
      animationStarted: animations,
      activate: async () => undefined,
      animateTo: async () => undefined,
      complete: vi.fn(async () => undefined),
      close: vi.fn(),
    },
  }));
  const [first, second, extra] = captures;
  extra!.pixels.resolve();
  extra!.context.resolve({ accessibleText: extra!.title });
  const state = {
    snapshots: 0,
    handoffs: 0,
    preparations: 0,
    preparedWithoutOverlay: true,
    failFirstPersistence: false,
  };
  const images = new Map<string, Uint8Array>();
  const metadata = new Map<string, string>();
  const readyIds: string[] = [];
  const requestedIds: string[] = [];
  const bounds = { x: 10, y: 20, width: 800, height: 600 };
  const takeSnapshot = async () => {
    const index = state.snapshots++;
    const capture = captures[Math.min(index, captures.length - 1)]!;
    capture.oldOverlaysCleared = flashWindows.every((window) => window.destroyed);
    capture.oldNativeFeedbackClosed = captures
      .slice(0, index)
      .every((previous) => previous.feedback.close.mock.calls.length > 0);
    capture.started.resolve();
    await capture.pixels.promise;
    return capture;
  };
  activeWindowMock.mockReset().mockImplementation(async () => {
    const capture = captures[Math.min(state.snapshots, captures.length - 1)]!;
    return {
      platform: platform === "darwin" ? "macos" : "windows",
      id: capture.id,
      title: capture.title,
      owner: { name: capture.title, processId: capture.processId },
      bounds,
    };
  });
  regionCaptureMock.mockReset().mockImplementation(async () => {
    const capture = await takeSnapshot();
    return { width: bounds.width, height: bounds.height, png: capture.png };
  });
  macCaptureMock.mockReset().mockImplementation(async (_active: unknown, imagePath: string) => {
    const capture = await takeSnapshot();
    images.set(imagePath, capture.png);
    return { source: { name: capture.title }, png: capture.png };
  });
  linuxCaptureMock.mockReset().mockImplementation(async () => {
    const capture = await takeSnapshot();
    return {
      png: capture.png,
      window: {
        title: capture.title,
        appName: capture.title,
        appIdentifier: `test.capture.${capture.id}`,
        processId: capture.processId,
        bounds,
      },
      feedback: capture.feedback,
    };
  });
  const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
  accessibilityProcessReadMock.mockImplementation(({ active }) => ({
    started: Promise.resolve(),
    result: captures.find((capture) => capture.processId === active.owner.processId)!.context
      .promise,
  }));
  const handoff = Effect.sync(() => captures[state.handoffs++]!.handoff.resolve());
  let randomByte = 0;
  const layer = Layer.mergeAll(
    testLayer(platform, {
      makeDirectory: () => Effect.void,
      writeFile: (path, bytes) =>
        Effect.sync(() => {
          images.set(path, bytes);
        }),
      writeFileString: (path, text) => {
        const pending = JSON.parse(text) as { source: { windowTitle: string } };
        return state.failFirstPersistence && pending.source.windowTitle === first!.title
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
              }),
            )
          : Effect.sync(() => {
              metadata.set(path, text);
            });
      },
      rename: (from, to) =>
        Effect.sync(() => {
          const image = images.get(from);
          if (image) {
            images.set(to, image);
            images.delete(from);
          }
          const text = metadata.get(from);
          if (text) {
            metadata.set(to, text);
            metadata.delete(from);
          }
        }),
      remove: (path) =>
        Effect.sync(() => {
          images.delete(path);
          metadata.delete(path);
        }),
      readFile: (path) => Effect.sync(() => images.get(path)!),
      readFileString: (path) => Effect.sync(() => metadata.get(path)!),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(++randomByte),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: handoff,
        prepareCaptureReveal: Effect.sync(() => {
          state.preparations++;
          state.preparedWithoutOverlay &&= flashWindows.every((window) => window.destroyed);
        }),
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: (event: DesktopSnapShotEvent) => {
          switch (event.type) {
            case "requested":
              return Effect.sync(() => {
                requestedIds.push(event.id);
              });
            case "started":
              return handoff;
            case "ready":
              return Effect.sync(() => {
                readyIds.push(event.id);
              });
            default:
              return Effect.void;
          }
        },
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
  );
  return {
    first: first!,
    second: second!,
    state,
    readyIds,
    requestedIds,
    layer,
    settings: {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotIncludeAccessibility: true,
      snapShotAnimations: animations,
      snapShotFlash: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    },
    trigger: () =>
      platform === "linux"
        ? portalShortcutInstances.at(-1)!.onCapture()
        : (registerShortcutMock.mock.calls.at(-1)![1] as () => Promise<void>)(),
    releaseAll: () => {
      for (const capture of captures) {
        capture.pixels.resolve();
        capture.context.resolve({ accessibleText: capture.title });
      }
    },
    reset: () => {
      focusedWindowMock.mockReset();
      linuxCaptureMock.mockReset().mockResolvedValue(undefined);
      accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
      mediaAccessStatusMock.mockReturnValue("not-determined");
      animationSettingsMock.mockReturnValue({
        prefersReducedMotion: true,
        shouldRenderRichAnimation: false,
      });
      vi.unstubAllEnvs();
    },
  };
}

it.effect("rejects desktop config changes outside Niri or Hyprland", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const previewError = yield* service
        .previewConfig({ operation: "install", chooseFile: false })
        .pipe(Effect.flip);
      const applyError = yield* service.applyConfig("unapproved-preview").pipe(Effect.flip);
      assert.equal(previewError.action, "preview-config");
      assert.equal(applyError.action, "apply-config");
      for (const error of [previewError, applyError]) {
        assert.equal(error.reason, "unsupported-session");
        assert.equal(error.message, "Config setup requires a Niri or Hyprland session.");
      }
    }),
  ).pipe(Effect.provide(testLayer("win32"))),
);

it.effect("reads and acknowledges queued captures through Effect services", () => {
  const captureId = "12345678-1234-1234-1234-123456789abc";
  const captureDirectory = "/state/snap-shots";
  const metadataPath = captureDirectory + "/" + captureId + ".json";
  const imagePath = captureDirectory + "/" + captureId + ".png";
  const removed: Array<string> = [];
  const metadata = JSON.stringify({
    id: captureId,
    name: "window.png",
    mimeType: "image/png",
    sizeBytes: 3,
    source: {
      kind: "snap-shot",
      capturedAt: "2026-08-24T11:00:00.000Z",
      appName: "Editor",
      windowTitle: "main.ts",
    },
  });
  const layer = testLayer("linux", {
    readDirectory: () => Effect.succeed([captureId + ".json", "invalid.json"]),
    readFileString: (filePath) => Effect.succeed(filePath === metadataPath ? metadata : "invalid"),
    readFile: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    remove: (filePath) =>
      Effect.sync(() => {
        removed.push(filePath);
      }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const pending = yield* service.listPending;
      assert.deepEqual(
        pending.map((capture) => capture.id),
        [captureId],
      );

      const capture = yield* service.read(captureId);
      assert.strictEqual(capture.dataUrl, "data:image/png;base64,AQID");

      yield* service.acknowledge(captureId);
      assert.deepEqual(removed.sort(), [imagePath, metadataPath].sort());
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("captures the active Windows window without enumerating desktop sources", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Untitled - Paint",
    owner: { name: "Paint.exe", processId: 123, path: "C:\\Windows\\System32\\mspaint.exe" },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
  getSourcesMock.mockReset();
  getFileIconMock.mockReset().mockResolvedValue(fakeIcon("file"));
  const writtenFiles: Array<[string, Uint8Array]> = [];
  let metadata = "";
  const layer = testLayer("win32", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: (path, bytes) =>
      Effect.sync(() => {
        writtenFiles.push([path, bytes]);
      }),
    writeFileString: (_, text) =>
      Effect.sync(() => {
        metadata = text;
      }),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      assert.deepEqual(regionCaptureMock.mock.calls, [[active.bounds]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.deepEqual(getFileIconMock.mock.calls, [[active.owner.path, { size: "normal" }]]);
      assert.deepEqual(writtenFiles[0]?.[1], png);
      const saved = yield* decodePendingMetadata(metadata);
      assert.equal(saved.source.appName, "Paint");
      assert.match(saved.source.appIconDataUrl ?? "", /base64,file:/);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect.each([
  { length: 1_000, suffix: "", expectedLength: 1_000 },
  { length: 1_001, suffix: "", expectedLength: 1_000 },
  { length: 999, suffix: "😀", expectedLength: 999 },
])(
  "preserves captures with native metadata of length $length and suffix $suffix",
  ({ length, suffix, expectedLength }) => {
    const png = Buffer.from([1, 2, 3]);
    const title = "t".repeat(length) + suffix;
    const appName = "a".repeat(254) + "😀";
    const appIdentifier = "b".repeat(254) + "😀";
    activeWindowMock.mockReset().mockResolvedValue({
      platform: "macos",
      id: 42,
      title,
      owner: { name: appName, bundleId: appIdentifier, processId: 123 },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    focusedWindowMock.mockReturnValue(undefined);
    allWindowsMock.mockReturnValue([]);
    macCaptureMock.mockReset().mockResolvedValue({ source: { name: title }, png });
    accessibilityProcessReadMock.mockReturnValueOnce({
      started: Promise.resolve(),
      result: Promise.resolve(undefined),
    });
    let metadata = "";
    const layer = testLayer("darwin", {
      makeDirectory: () => Effect.void,
      rename: () => Effect.void,
      writeFileString: (_, text) =>
        Effect.sync(() => {
          metadata = text;
        }),
      readDirectory: () => Effect.succeed(["capture.json"]),
      readFileString: () => Effect.succeed(metadata),
      readFile: () => Effect.succeed(png),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        const pending = yield* service.listPending;
        assert.lengthOf(pending, 1);
        const capture = yield* service.read(pending[0]!.id);
        assert.equal(capture.dataUrl, "data:image/png;base64,AQID");
        assert.equal(capture.source.windowTitle, "t".repeat(expectedLength));
        assert.equal(capture.source.appName, "a".repeat(254));
        assert.equal(capture.source.appIdentifier, "b".repeat(254));
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect.each(["win32", "darwin", "linux"] as const)(
  "captures the foreground window in place from the shortcut on %s",
  (platform) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    registerShortcutMock.mockReset().mockReturnValue(true);
    mediaAccessStatusMock.mockReturnValue("granted");
    animationSettingsMock.mockReturnValue({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    });
    const bounds = { x: 10, y: 20, width: 800, height: 600 };
    const t3 = {
      id: 42,
      title: "T3 Code",
      appIdentifier: "com.t3tools.T3Code.desktop",
      owner: { name: "T3 Code", processId: 123 },
      bounds,
      png: Buffer.from([1, 2, 3]),
    };
    focusedWindowMock.mockReturnValue({
      getBounds: () => bounds,
      getTitle: () => t3.title,
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      show: vi.fn(),
      restore: vi.fn(),
    });
    const images: Uint8Array[] = [];
    activeWindowMock.mockReset().mockResolvedValue({
      ...t3,
      platform: platform === "darwin" ? "macos" : "windows",
    });
    regionCaptureMock.mockReset().mockResolvedValue({
      width: bounds.width,
      height: bounds.height,
      png: t3.png,
    });
    macCaptureMock.mockReset().mockImplementation(async () => {
      images.push(t3.png);
      return { source: { name: t3.title }, png: t3.png };
    });
    const activate = vi.fn<(title: string) => Promise<void>>().mockResolvedValue(undefined);
    linuxCaptureMock.mockResolvedValueOnce({
      png: t3.png,
      window: {
        title: t3.title,
        appName: t3.owner.name,
        appIdentifier: t3.appIdentifier,
        processId: t3.owner.processId,
        bounds,
      },
      feedback: {
        animationStarted: true,
        activate,
        animateTo: async () => undefined,
        complete: async () => undefined,
        close: () => undefined,
      },
    });
    const readAccessibility = accessibilityProcessReadMock.getMockImplementation()!;
    accessibilityProcessReadMock.mockImplementation(({ active }) => ({
      started: Promise.resolve(),
      result: Promise.resolve({ accessibleText: `Window from process ${active.owner.processId}` }),
    }));
    let metadata = "";

    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(
          enabledSettings({
            snapShotFlash: false,
            snapShotShortcut: {
              key: "2",
              ctrlKey: true,
              shiftKey: true,
              altKey: false,
              metaKey: false,
              modKey: false,
            },
          }),
        );
        const trigger =
          platform === "linux"
            ? portalShortcutInstances.at(-1)!.onCapture
            : registerShortcutMock.mock.calls.at(-1)![1];
        yield* Effect.promise(trigger);

        const saved = yield* decodePendingMetadata(metadata);
        assert.equal(saved.source.windowTitle, t3.title);
        assert.equal(saved.source.appName, t3.owner.name);
        assert.equal(saved.source.accessibleText, `Window from process ${t3.owner.processId}`);
        assert.deepEqual(images, [t3.png]);
        assert.equal(prepareCaptureRevealMock.mock.calls.length, platform === "win32" ? 1 : 0);
        if (platform === "linux") {
          assert.equal(saved.source.appIdentifier, t3.appIdentifier);
          assert.deepEqual(activate.mock.calls, [[t3.title]]);
        }
      }),
    ).pipe(
      Effect.provide(
        testLayer(platform, {
          makeDirectory: () => Effect.void,
          rename: () => Effect.void,
          writeFile: (_, bytes) =>
            Effect.sync(() => {
              images.push(bytes);
            }),
          writeFileString: (_, text) =>
            Effect.sync(() => {
              metadata = text;
            }),
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          focusedWindowMock.mockReset();
          linuxCaptureMock.mockReset().mockResolvedValue(undefined);
          accessibilityProcessReadMock.mockReset().mockImplementation(readAccessibility);
          mediaAccessStatusMock.mockReturnValue("not-determined");
          animationSettingsMock.mockReturnValue({
            prefersReducedMotion: true,
            shouldRenderRichAnimation: false,
          });
          vi.unstubAllEnvs();
        }),
      ),
    );
  },
);

it.effect.each(["win32", "darwin", "linux"] as const)(
  "ignores shortcut repeats for 200 ms without delaying the first capture on %s",
  (platform) => {
    const fixture = concurrentCaptureFixture(platform, false);
    fixture.releaseAll();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        yield* service.setShortcutSuppressed(true);
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 0);
        yield* service.setShortcutSuppressed(false);
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 1);
        assert.lengthOf(fixture.readyIds, 1);

        yield* Effect.promise(fixture.trigger);
        yield* TestClock.adjust("199 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 1);
        assert.lengthOf(fixture.readyIds, 1);

        yield* TestClock.adjust("1 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        assert.lengthOf(fixture.readyIds, 2);

        yield* service.capture;
        assert.equal(fixture.state.snapshots, 3);
        assert.lengthOf(fixture.readyIds, 3);
      }),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect.each([
  { platform: "win32", animations: true },
  { platform: "darwin", animations: false },
  { platform: "linux", animations: true },
] as const)(
  "captures again while accessibility is pending on $platform (animations: $animations)",
  ({ platform, animations }) => {
    const fixture = concurrentCaptureFixture(platform, animations);
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.started.promise);
        assert.lengthOf(fixture.requestedIds, 1);
        assert.lengthOf(fixture.readyIds, 0);
        fixture.first.pixels.resolve();
        yield* Effect.promise(() => fixture.first.handoff.promise);
        assert.lengthOf(fixture.readyIds, 0);

        yield* TestClock.adjust("200 millis");
        fixture.second.pixels.resolve();
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.handoff.promise);
        assert.equal(fixture.state.snapshots, 2);
        assert.isTrue(fixture.second.oldOverlaysCleared);
        assert.equal(fixture.state.preparations, platform === "win32" ? 2 : 0);
        assert.isTrue(fixture.state.preparedWithoutOverlay);
        if (platform === "linux") assert.isTrue(fixture.second.oldNativeFeedbackClosed);
        const secondOverlays = flashWindows.filter((window) => !window.destroyed);
        if (platform !== "linux") assert.isNotEmpty(secondOverlays);

        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.lengthOf(fixture.readyIds, 1);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, 2);
        assert.equal(new Set(fixture.readyIds).size, 2);
        assert.deepEqual(fixture.readyIds, fixture.requestedIds.toReversed());
        const newer = yield* service.read(fixture.readyIds[0]!);
        const older = yield* service.read(fixture.readyIds[1]!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
        assert.equal(
          newer.dataUrl,
          `data:image/png;base64,${fixture.second.png.toString("base64")}`,
        );
        assert.equal(older.source.windowTitle, fixture.first.title);
        assert.equal(older.source.accessibleText, "Discord accessibility");
        assert.equal(
          older.dataUrl,
          `data:image/png;base64,${fixture.first.png.toString("base64")}`,
        );

        yield* service.acknowledge(fixture.readyIds[1]!);
        assert.isTrue(secondOverlays.every((window) => !window.destroyed));
        if (platform === "linux") {
          assert.lengthOf(fixture.second.feedback.close.mock.calls, 0);
          assert.lengthOf(fixture.second.feedback.complete.mock.calls, 0);
        }
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect.each(["succeeds", "fails"] as const)(
  "keeps the newer snapshot exclusive when older persistence %s",
  (outcome) => {
    const fixture = concurrentCaptureFixture("win32", true);
    fixture.state.failFirstPersistence = outcome === "fails";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        fixture.first.pixels.resolve();
        const first = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.first.handoff.promise);
        yield* TestClock.adjust("200 millis");
        const second = yield* Effect.promise(fixture.trigger).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => fixture.second.started.promise);

        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
        yield* Fiber.join(first);
        assert.lengthOf(fixture.readyIds, outcome === "succeeds" ? 1 : 0);
        yield* TestClock.adjust("200 millis");
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);

        fixture.second.pixels.resolve();
        yield* Effect.promise(() => fixture.second.handoff.promise);
        fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
        yield* Fiber.join(second);
        assert.equal(fixture.state.handoffs, 2);
        const newer = yield* service.read(fixture.readyIds.at(-1)!);
        assert.equal(newer.source.windowTitle, fixture.second.title);
        assert.equal(newer.source.accessibleText, "Explorer accessibility");
      }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
    ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
  },
);

it.effect("keeps newer native feedback when older accessibility persistence fails", () => {
  const fixture = concurrentCaptureFixture("linux", true);
  fixture.state.failFirstPersistence = true;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(fixture.settings);
      fixture.first.pixels.resolve();
      const first = yield* Effect.promise(fixture.trigger).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => fixture.first.handoff.promise);
      yield* TestClock.adjust("200 millis");
      fixture.second.pixels.resolve();
      const second = yield* Effect.promise(fixture.trigger).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => fixture.second.handoff.promise);
      fixture.first.context.resolve({ accessibleText: "Discord accessibility" });
      yield* Fiber.join(first);

      assert.lengthOf(fixture.readyIds, 0);
      assert.lengthOf(fixture.second.feedback.close.mock.calls, 0);
      assert.lengthOf(fixture.second.feedback.complete.mock.calls, 0);
      fixture.second.context.resolve({ accessibleText: "Explorer accessibility" });
      yield* Fiber.join(second);
      assert.lengthOf(fixture.readyIds, 1);
      const newer = yield* service.read(fixture.readyIds[0]!);
      assert.equal(newer.source.windowTitle, fixture.second.title);
      yield* service.acknowledge(fixture.readyIds[0]!);
      assert.lengthOf(fixture.second.feedback.complete.mock.calls, 1);
    }).pipe(Effect.ensuring(Effect.sync(fixture.releaseAll))),
  ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Effect.sync(fixture.reset)));
});

it.effect("matches Windows accessibility windows on a scaled display", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  const dipBounds = { x: 5, y: 10, width: 400, height: 300 };
  activeWindowMock.mockReset().mockResolvedValue(active);
  screenToDipRectMock.mockImplementation(() => dipBounds);
  regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
  accessibilityForegroundMock.mockReset().mockResolvedValue({
    pid: 123,
    asElement: () => ({
      role: "window",
      name: "Editor",
      bounds: dipBounds,
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 105, y: 110, width: 100, height: 50 },
          children: async () => [],
        },
      ],
      tree: async () => ({ name: "Editor", value: "Scaled text", children: [] }),
    }),
  });
  let metadata = "";
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;
      const saved = yield* decodePendingMetadata(metadata);
      assert.include(saved.source.accessibleText, "Scaled text");
      assert.deepEqual(
        saved.source.accessibility?.format === "element-tree"
          ? saved.source.accessibility.root.children[0]?.bounds
          : undefined,
        { x: 200, y: 200, width: 200, height: 100 },
      );
    }),
  ).pipe(
    Effect.provide(
      testLayer("win32", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        screenToDipRectMock.mockImplementation((_window, bounds) => bounds);
      }),
    ),
  );
});

it.effect("skips accessibility capture when the setting is disabled", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "windows",
    id: 42,
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
  accessibilityProcessWarmMock.mockClear();
  accessibilityProcessReadMock.mockClear();
  accessibilityByPidMock.mockClear();
  const layer = testLayer("win32", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings({ snapShotIncludeAccessibility: false }));
      yield* service.capture;

      assert.lengthOf(accessibilityProcessWarmMock.mock.calls, 0);
      assert.lengthOf(accessibilityProcessReadMock.mock.calls, 0);
      assert.lengthOf(accessibilityByPidMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("keeps an accessibility helper warm only while capture data is enabled", () => {
  accessibilityProcessWarmMock.mockClear();
  accessibilityProcessCoolMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: true,
      });

      assert.lengthOf(accessibilityProcessWarmMock.mock.calls, 1);
      assert.lengthOf(accessibilityProcessCoolMock.mock.calls, 0);

      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: false,
        snapShotIncludeAccessibility: true,
      });

      assert.lengthOf(accessibilityProcessCoolMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("rejects X11 capture without registering shortcuts or loading capture backends", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "x11");
  vi.stubEnv("WAYLAND_DISPLAY", "");
  linuxCaptureMock.mockClear();
  activeWindowMock.mockClear();
  registerShortcutMock.mockClear();
  shortcutProcesses.length = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true });
      const state = yield* service.state;
      assert.equal(state.mode, "unavailable");
      assert.include(state.message, "Wayland");
      const result = yield* Effect.flip(service.capture);
      assert.equal(result.operation, "unsupported");
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.lengthOf(shortcutProcesses, 0);
      assert.lengthOf(linuxCaptureMock.mock.calls, 0);
      assert.lengthOf(activeWindowMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect.each(["gnome", "niri", "kde", "hyprland"] as const)(
  "persists %s text without inventing AT-SPI screen coordinates",
  (backend) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    flashWindows.length = 0;
    const window = {
      title: "Editor",
      appName: "Text Editor",
      appIdentifier: "org.gnome.TextEditor.desktop",
      processId: 123,
      bounds: {
        x: backend === "niri" ? 0 : 479,
        y: backend === "niri" ? 0 : 342,
        width: 700,
        height: backend === "kde" ? 549 : 520,
      },
      ...(backend === "niri" ? { accessibilityBoundsReliable: false } : {}),
      ...(backend === "kde" ? { clientBounds: { x: 479, y: 371, width: 700, height: 520 } } : {}),
    };
    linuxCaptureMock.mockResolvedValueOnce({ png: Buffer.from([1, 2, 3]), window });
    activeWindowMock.mockClear();
    getSourcesMock.mockClear();
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          role: "window",
          name: "Editor",
          bounds: { x: 0, y: 0, width: 700, height: 520 },
          active: true,
          children: async () => [
            {
              role: "button",
              name: "Save",
              bounds: { x: 10, y: 20, width: 80, height: 24 },
              focused: true,
              actions: ["press"],
              children: async () => [],
            },
          ],
          tree: async () => ({ name: "Editor", value: "Verified text", children: [] }),
        },
      ],
    });
    let metadata = "";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        assert.lengthOf(activeWindowMock.mock.calls, 0);
        assert.lengthOf(getSourcesMock.mock.calls, 0);
        assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
        const saved = yield* decodePendingMetadata(metadata);
        assert.equal(saved.source.appName, "Text Editor");
        assert.equal(saved.source.appIdentifier, window.appIdentifier);
        assert.include(saved.source.accessibleText, "Verified text");
        assert.deepInclude(saved.source.accessibility, {
          format: "element-tree",
          coordinateSpace: "captured-image",
          imageSize: { width: 700, height: window.bounds.height },
          truncated: false,
        });
        assert.deepInclude(
          saved.source.accessibility?.format === "element-tree"
            ? saved.source.accessibility.root
            : undefined,
          {
            role: "window",
            name: "Editor",
            bounds: { x: 0, y: 0, width: 700, height: window.bounds.height },
            state: { active: true },
          },
        );
        assert.isNull(
          saved.source.accessibility?.format === "element-tree"
            ? saved.source.accessibility.root.children[0]?.bounds
            : undefined,
        );
        assert.lengthOf(flashWindows, 0);
      }),
    ).pipe(
      Effect.provide(
        testLayer("linux", {
          makeDirectory: () => Effect.void,
          rename: () => Effect.void,
          writeFile: () => Effect.void,
          writeFileString: (_, text) =>
            Effect.sync(() => {
              metadata = text;
            }),
        }),
      ),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect("persists a window capture from a portal activation without a setup test", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  linuxCaptureMock.mockClear().mockResolvedValueOnce({
    png: Buffer.from([1, 2, 3]),
    window: {
      title: "Shortcut capture",
      appName: "Text Editor",
      appIdentifier: "org.kde.kwrite",
      processId: 123,
      bounds: { x: 0, y: 0, width: 700, height: 520 },
    },
  });
  let metadata = "";
  const writes: Uint8Array[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
        snapShotShortcut: {
          key: "2",
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: false,
          modKey: false,
        },
      });
      yield* Effect.promise(portalShortcutInstances[0]!.onCapture);
      assert.lengthOf(linuxCaptureMock.mock.calls, 1);
      assert.deepEqual(writes, [Buffer.from([1, 2, 3])]);
      const saved = yield* decodePendingMetadata(metadata);
      assert.equal(saved.source.windowTitle, "Shortcut capture");
      assert.equal(saved.source.appIdentifier, "org.kde.kwrite");
      const state = yield* service.state;
      assert.isTrue(state.shortcutVerified);
      assert.isNull(state.message);
      const portal = portalShortcutInstances[0]!;
      portal.state = {
        shortcutRegistered: false,
        shortcutPending: false,
        shortcutMessage: "Permission revoked",
      };
      portal.onStateChanged();
      const revoked = yield* service.state;
      assert.isFalse(revoked.shortcutVerified);
      assert.isFalse(revoked.shortcutRegistered);
    }),
  ).pipe(
    Effect.provide(
      testLayer("linux", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: (_, bytes) =>
          Effect.sync(() => {
            writes.push(bytes);
          }),
        writeFileString: (_, text) =>
          Effect.sync(() => {
            metadata = text;
          }),
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("does not fall back to the picker when an automatic Wayland capture fails", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  linuxCaptureMock.mockRejectedValueOnce(new Error("Capture denied"));
  getSourcesMock.mockClear();
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "capture");
      assert.lengthOf(getSourcesMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(
      testLayer("linux", {
        makeDirectory: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect(
  "logs a GNOME activation failure and completes the shell flight before acknowledging the image",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const order: string[] = [];
    const activationFailure = new Error("Activation failed");
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => logs.push(message));
    const feedback = {
      animationStarted: true,
      activate: async () => {
        order.push("activate");
        throw activationFailure;
      },
      animateTo: async () => {
        order.push("land");
      },
      complete: async () => {
        order.push("complete");
      },
      close: () => {
        order.push("close");
      },
    };
    linuxCaptureMock.mockImplementationOnce(async () => {
      order.push("snapshot");
      return { png: Buffer.from([1, 2, 3]), feedback };
    });
    focusedWindowMock.mockReturnValue(undefined);
    const destination = {
      getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      getTitle: () => "T3 Code",
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
    };
    allWindowsMock.mockReturnValue([destination]);
    let saved = "";
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(enabledSettings());
        yield* service.capture;
        assert.deepEqual(order, ["snapshot", "activate"]);
        const warning = logs.find(
          (message) =>
            Array.isArray(message) &&
            message[0] === "The compositor could not activate T3 Code after the snapshot",
        );
        assert.strictEqual(Array.isArray(warning) ? warning[1] : undefined, activationFailure);
        const pending = yield* decodePendingMetadata(saved);
        yield* service.setAnimationDestination(pending.id, {
          frame: { x: 0, y: 0, width: 10, height: 10 },
          relativeFrame: { x: 0.1, y: 0.8, width: 0.2, height: 0.1 },
          backgroundColor: "white",
          borderColor: "black",
          borderWidth: 1,
          cornerRadius: 8,
          scaleFactor: 1,
        });
        yield* service.acknowledge(pending.id);
        assert.deepEqual(order, ["snapshot", "activate", "land", "complete", "delete", "delete"]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer("linux", {
            makeDirectory: () => Effect.void,
            rename: () => Effect.void,
            writeFile: () => Effect.void,
            writeFileString: (_, value) =>
              Effect.sync(() => {
                saved = value;
              }),
            remove: () =>
              Effect.sync(() => {
                order.push("delete");
              }),
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          allWindowsMock.mockReturnValue([]);
          vi.unstubAllEnvs();
        }),
      ),
    );
  },
);

it.effect("does not read unverified accessibility context for a Wayland portal capture", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const png = Buffer.from([1, 2, 3]);
  accessibilityForegroundMock.mockReset();
  getSourcesMock.mockReset().mockResolvedValue([
    {
      id: "window:42:0",
      name: "Untitled",
      thumbnail: { isEmpty: () => false, toPNG: () => png },
    },
  ]);
  const layer = testLayer("linux", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFile: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      assert.lengthOf(accessibilityForegroundMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
});

it.effect("uses display-local macOS capture surfaces across the source and main displays", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "macos",
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({
    source: { name: "Terminal" },
    png,
  });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  focusedWindowMock.mockReturnValue({
    getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
    isDestroyed: () => false,
  });
  flashWindows.length = 0;
  const layer = testLayer("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      const transitionWindows = flashWindows.filter((window) => window.kind === "browser");
      assert.deepEqual(
        transitionWindows.map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
      for (const transitionWindow of transitionWindows) {
        assert.deepEqual(transitionWindow.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
      }
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => focusedWindowMock.mockReset())));
});

it.effect.each(["ready", "failed"] as const)(
  "shows the Windows transition only once its snapshot decode is %s",
  (outcome) => {
    const png = Buffer.from([1, 2, 3]);
    activeWindowMock.mockReset().mockResolvedValue({
      platform: "windows",
      id: 42,
      title: "Editor",
      owner: { name: "Editor", processId: 123 },
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    regionCaptureMock.mockReset().mockResolvedValue({ width: 800, height: 600, png });
    animationSettingsMock.mockReturnValueOnce({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    });
    const decoding = Promise.withResolvers<void>();
    const decoded = Promise.withResolvers<void>();
    transitionSnapshotMock.mockImplementation(() => {
      decoding.resolve();
      return decoded.promise;
    });
    focusedWindowMock.mockReturnValue({
      getBounds: () => ({ x: 100, y: 50, width: 1_200, height: 800 }),
      isDestroyed: () => false,
    });
    transitionShowMock.mockClear();
    flashWindows.length = 0;

    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(
          enabledSettings({ snapShotIncludeAccessibility: false, snapShotFlash: false }),
        );
        const capture = yield* service.capture.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => decoding.promise);
        assert.lengthOf(transitionShowMock.mock.calls, 0);

        if (outcome === "ready") decoded.resolve();
        else decoded.reject(new Error("Snapshot decode failed"));
        yield* Fiber.join(capture);

        if (outcome === "ready") {
          assert.isNotEmpty(transitionShowMock.mock.calls);
        } else {
          assert.lengthOf(transitionShowMock.mock.calls, 0);
          assert.isTrue(flashWindows.every((window) => window.destroyed));
        }
      }),
    ).pipe(
      Effect.provide(
        testLayer("win32", {
          makeDirectory: () => Effect.void,
          rename: () => Effect.void,
          writeFile: () => Effect.void,
          writeFileString: () => Effect.void,
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          decoded.resolve();
          focusedWindowMock.mockReset();
        }),
      ),
    );
  },
);

it.effect("uses the unfocused main window for a macOS cross-display transition", () => {
  const png = Buffer.from([1, 2, 3]);
  const active = {
    platform: "macos",
    id: 42,
    title: "Terminal",
    owner: { name: "Terminal", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as const;
  activeWindowMock.mockReset().mockResolvedValue(active);
  accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [] });
  macCaptureMock.mockReset().mockResolvedValue({ source: { name: "Terminal" }, png });
  animationSettingsMock.mockReturnValueOnce({
    prefersReducedMotion: false,
    shouldRenderRichAnimation: true,
  });
  focusedWindowMock.mockReturnValue(undefined);
  allWindowsMock.mockReturnValue([
    {
      getBounds: () => ({ x: -1_600, y: 100, width: 1_200, height: 800 }),
      isDestroyed: () => false,
    },
  ]);
  flashWindows.length = 0;
  const layer = testLayer("darwin", {
    makeDirectory: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(enabledSettings());
      yield* service.capture;

      assert.deepEqual(
        flashWindows.filter((window) => window.kind === "browser").map((window) => window.bounds),
        [
          { x: 0, y: -200, width: 1_440, height: 900 },
          { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        ],
      );
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.ensuring(
      Effect.sync(() => {
        focusedWindowMock.mockReset();
        allWindowsMock.mockReset();
      }),
    ),
  );
});

function fakeIcon(label: string, empty = false): Electron.NativeImage {
  return {
    isEmpty: () => empty,
    resize: ({ width, height, quality }) => ({
      toDataURL: (options) =>
        "data:image/png;base64," +
        label +
        ":" +
        width +
        "x" +
        height +
        ":" +
        quality +
        "@" +
        options?.scaleFactor,
    }),
  } as Electron.NativeImage;
}

it.each([
  ["OS app", fakeIcon("file"), fakeIcon("captured"), "file"],
  ["captured app", fakeIcon("file", true), fakeIcon("captured"), "captured"],
])("exports the %s icon at high density", (_source, fileIcon, capturedIcon, expectedLabel) => {
  const dataUrl = DesktopSnapShot.snapShotIconDataUrl(fileIcon, capturedIcon);

  assert.strictEqual(dataUrl, "data:image/png;base64," + expectedLabel + ":64x64:best@2");
});

const activeEditor = {
  owner: { path: "/Applications/Editor.app" },
} as Parameters<typeof DesktopSnapShot.iconDataUrl>[1];

it.each([
  [
    "a failed thumbnail on darwin",
    "darwin" as const,
    () => thumbnailFromPathMock.mockRejectedValue(new Error("no thumbnail")),
  ],
  ["other platforms", "win32" as const, () => {}],
])(
  "requests the file icon at a size supported on macOS after %s",
  async (_case, platform, arrange) => {
    getFileIconMock.mockReset();
    thumbnailFromPathMock.mockReset();
    arrange();
    getFileIconMock.mockResolvedValue(fakeIcon("file"));

    const dataUrl = await DesktopSnapShot.iconDataUrl(
      { appIcon: fakeIcon("captured") },
      activeEditor,
      platform,
    );

    assert.deepEqual(getFileIconMock.mock.calls, [
      ["/Applications/Editor.app", { size: "normal" }],
    ]);
    assert.strictEqual(dataUrl, "data:image/png;base64,file:64x64:best@2");
  },
);

it("uses the primary display for portal flash feedback", () => {
  assert.deepEqual(DesktopSnapShot.snapShotFlashBounds(undefined, "linux"), {
    x: 0,
    y: 0,
    width: 1_440,
    height: 900,
  });
});

it("uses the operating system animation policy", () => {
  assert.isTrue(
    DesktopSnapShot.shouldAnimateSnapShot({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    }),
  );
  assert.isFalse(
    DesktopSnapShot.shouldAnimateSnapShot({
      prefersReducedMotion: true,
      shouldRenderRichAnimation: true,
    }),
  );
});

it("scales transition timing with travel distance", () => {
  const source = { x: 0, y: 0, width: 200, height: 100 };
  assert.strictEqual(snapShotAnimationDurationMs(source, source), 280);
  const near = snapShotAnimationDurationMs(source, {
    x: 100,
    y: 0,
    width: 200,
    height: 100,
  });
  const far = snapShotAnimationDurationMs(source, {
    x: 1_000,
    y: 0,
    width: 200,
    height: 100,
  });

  assert.isAtLeast(near, 280);
  assert.isBelow(far, 570);
  assert.isAbove(far, near);
});

it("bounds the transition surface to its displays", () => {
  assert.deepEqual(
    snapShotAnimationOverlayBounds([
      { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
      { bounds: { x: 0, y: -200, width: 1_440, height: 900 } },
    ]),
    { x: -1_920, y: -200, width: 3_360, height: 1_280 },
  );
});

it("covers straddling captures and intervening monitors without spanning unrelated displays", () => {
  const displays = [
    { bounds: { x: -1_920, y: 0, width: 1_920, height: 1_080 } },
    { bounds: { x: 0, y: 0, width: 1_440, height: 900 } },
    { bounds: { x: 1_440, y: 0, width: 1_280, height: 720 } },
    { bounds: { x: 0, y: -1_080, width: 1_920, height: 1_080 } },
  ];
  const source = { x: -200, y: 100, width: 800, height: 600 };
  assert.deepEqual(
    snapShotAnimationDisplayBounds(displays, source, source),
    displays.slice(0, 2).map((display) => display.bounds),
  );
  assert.deepEqual(
    snapShotAnimationDisplayBounds(
      displays,
      { x: -1_800, y: 100, width: 800, height: 600 },
      { x: 1_600, y: 200, width: 200, height: 112 },
    ),
    displays.slice(0, 3).map((display) => display.bounds),
  );
});

it("keeps cross-display handoff surfaces local to each display", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(
      flashWindows.map((window) => window.bounds),
      [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: -200, width: 1_440, height: 900 },
      ],
    );
    for (const window of flashWindows) {
      assert.strictEqual(window.resizeCount, 0);
    }
  } finally {
    transition.dispose();
  }
});

it("adds a newly selected destination display without resizing existing surfaces", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ boundOverlayToCaptureDisplays: true });
  const snapshot = "data:image/png;base64,captured-window";

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      snapshot,
      false,
      { x: -1_600, y: 100, width: 1_000, height: 700 },
    );
    assert.lengthOf(flashWindows, 1);
    const initialWindow = flashWindows[0];

    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.strictEqual(flashWindows[0], initialWindow);
    assert.deepEqual(
      flashWindows.map((window) => window.bounds),
      [
        { x: -1_920, y: 0, width: 1_920, height: 1_080 },
        { x: 0, y: -200, width: 1_440, height: 900 },
      ],
    );
    for (const window of flashWindows) {
      assert.strictEqual(window.resizeCount, 0);
      assert.strictEqual(window.showCount, 1);
    }
  } finally {
    transition.dispose();
  }
});

it("cancels a late display while its snapshot is still decoding", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ boundOverlayToCaptureDisplays: true });
  const decoding = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionSnapshotMock.mockImplementationOnce(() => {
      decoding.resolve();
      return decoded.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await decoding.promise;

    transition.dismiss("capture-1");
    decoded.resolve();
    await landing;

    assert.lengthOf(flashWindows, 2);
    assert.strictEqual(flashWindows[1]?.showCount, 0);
    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    decoded.resolve();
    transition.dispose();
  }
});

it("waits for every initial compositor frame before completing capture feedback", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    boundOverlayToCaptureDisplays: true,
    waitForCompositorFrame: true,
  });
  const frames = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const readingFrames = Promise.withResolvers<void>();
  let frameIndex = 0;
  let ready = false;
  transitionCapturePageMock.mockImplementation(() => {
    const frame = frames[frameIndex++]!;
    if (frameIndex === frames.length) readingFrames.resolve();
    return frame.promise;
  });

  try {
    const begin = transition
      .begin(
        "capture-1",
        { x: -1_800, y: 50, width: 900, height: 600 },
        "data:image/png;base64,",
        true,
        { x: 100, y: 50, width: 1_000, height: 700 },
      )
      .then(() => {
        ready = true;
      });
    await readingFrames.promise;
    frames[0]!.resolve();
    await frames[0]!.promise;

    assert.isFalse(ready);
    for (const window of flashWindows) {
      assert.strictEqual(window.showCount, 1);
    }
    frames[1]!.resolve();
    await begin;

    assert.isTrue(ready);
  } finally {
    for (const frame of frames) frame.resolve();
    transition.dispose();
  }
});

it("does not flash a dismissed overlay after its initial compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  transitionCapturePageMock.mockImplementation(() => {
    readingFrame.resolve();
    return frame.promise;
  });

  try {
    const begin = transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      true,
    );
    await readingFrame.promise;
    transition.dismiss("capture-1");
    frame.resolve();
    await begin;

    for (const window of flashWindows) {
      assert.isTrue(window.destroyed);
    }
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("waits for every display's prepared compositor frame before starting any flight", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    boundOverlayToCaptureDisplays: true,
    waitForCompositorFrame: true,
  });
  const frames = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const readingFrames = Promise.withResolvers<void>();
  let frameIndex = 0;
  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transitionCapturePageMock.mockImplementation(() => {
      const frame = frames[frameIndex++]!;
      if (frameIndex === frames.length) readingFrames.resolve();
      return frame.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await readingFrames.promise;
    frames[0]!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    for (const window of flashWindows) {
      assert.deepEqual(window.capturedRegions, [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: 1, height: 1 },
      ]);
    }

    frames[1]!.resolve();
    await landing;
  } finally {
    for (const frame of frames) frame.resolve();
    transition.dispose();
  }
});

it("does not start a dismissed transition after its compositor receipt arrives", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({ waitForCompositorFrame: true });
  const readingFrame = Promise.withResolvers<void>();
  const frame = Promise.withResolvers<void>();
  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transitionCapturePageMock.mockImplementation(() => {
      readingFrame.resolve();
      return frame.promise;
    });
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    const landing = transition.waitForLanding("capture-1");
    await readingFrame.promise;
    transition.dismiss("capture-1");
    frame.resolve();
    await landing;

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    frame.resolve();
    transition.dispose();
  }
});

it("keeps flying on the destination display when the capture display fails", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: -1_800, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 100, y: 50, width: 1_000, height: 700 },
    );
    transitionScriptState.rejectFlight = true;
    transitionScriptState.heldFlights = [];
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    let landed = false;
    const landing = transition.waitForLanding("capture-1").then(() => {
      landed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.lengthOf(transitionScriptState.heldFlights, 1);
    assert.isFalse(landed);

    for (const release of transitionScriptState.heldFlights) release();
    await landing;
  } finally {
    transitionScriptState.rejectFlight = false;
    transitionScriptState.heldFlights = null;
    transition.dispose();
  }
});

it("keeps same-display motion inside one stable surface", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    boundOverlayToCaptureDisplays: true,
  });

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
      { x: 200, y: 100, width: 1_000, height: 700 },
    );
    transition.animateTo("capture-1", {
      frame: { x: 600, y: 400, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });
    await transition.waitForLanding("capture-1");

    assert.deepEqual(flashWindows[0]?.bounds, {
      x: 0,
      y: -200,
      width: 1_440,
      height: 900,
    });
    assert.strictEqual(flashWindows[0]?.resizeCount, 0);
  } finally {
    transition.dispose();
  }
});

it("keeps the Windows transition above the revealed main window", async () => {
  flashWindows.length = 0;
  const transition = new SnapShotTransition({
    alwaysOnTopLevel: "pop-up-menu",
  });

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );

    assert.deepEqual(flashWindows[0]?.alwaysOnTopCalls, [[true, "pop-up-menu"]]);
  } finally {
    transition.dispose();
  }
});

it("does not let a failed transition fail landing or capture completion", async () => {
  flashWindows.length = 0;
  transitionScriptState.rejectFlight = true;
  const transition = new SnapShotTransition();

  try {
    await transition.begin(
      "capture-1",
      { x: 100, y: 50, width: 900, height: 600 },
      "data:image/png;base64,",
      false,
    );
    transition.animateTo("capture-1", {
      frame: { x: 20, y: 20, width: 208, height: 112 },
      backgroundColor: "#fff",
      borderColor: "#ccc",
      borderWidth: 1,
      cornerRadius: 8,
      scaleFactor: 1,
    });

    await transition.waitForLanding("capture-1");
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
});

it("bounds source thumbnails for large windows", () => {
  assert.deepEqual(
    DesktopSnapShot.snapShotThumbnailSize({
      bounds: { x: 0, y: 0, width: 6_000, height: 4_000 },
    } as Parameters<typeof DesktopSnapShot.snapShotThumbnailSize>[0]),
    { width: 2_560, height: 1_600 },
  );
});

it.each(["client", "frame"] as const)(
  "maps KDE %s accessibility coordinates into the decorated screenshot",
  async (rootArea) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const clientBounds = { x: 100, y: 229, width: 800, height: 571 };
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          role: "window",
          name: "Editor",
          bounds: rootArea === "client" ? clientBounds : bounds,
          tree: async () => ({ name: "Editor", children: [{ name: "Save", children: [] }] }),
          children: async () => [
            {
              role: "button",
              name: "Save",
              bounds: { x: 120, y: 249, width: 100, height: 50 },
              children: async () => [],
            },
          ],
        },
      ],
    });
    try {
      const context = await readAccessibleWindowContext(
        { title: "Editor", bounds, clientBounds, owner: { processId: 123 } },
        "linux",
        "Editor",
        { width: 1600, height: 1200 },
      );
      assert.equal(context?.accessibility?.format, "element-tree");
      assert.deepEqual(
        context?.accessibility?.format === "element-tree"
          ? context.accessibility.root.children[0]?.bounds
          : undefined,
        { x: 40, y: 98, width: 200, height: 100 },
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(["darwin", "win32"] as const)(
  "extracts the same structured accessibility tree on %s",
  async (platform) => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({ name: "Editor", children: [{ name: "Save", children: [] }] }),
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 300, y: 350, width: 100, height: 50 },
          children: async () => [],
        },
      ],
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });

    const result = await readAccessibleWindowContext(
      { title: "Editor", bounds, owner: { processId: 123 } },
      platform,
      "Editor",
      { width: 1_600, height: 1_200 },
    );

    assert.equal(result?.accessibility?.format, "element-tree");
    assert.equal(
      result?.accessibility?.format === "element-tree"
        ? result.accessibility.root.children[0]?.name
        : undefined,
      "Save",
    );
    assert.lengthOf(accessibilityByPidMock.mock.calls, platform === "win32" ? 0 : 1);
    assert.lengthOf(accessibilityForegroundMock.mock.calls, platform === "win32" ? 1 : 0);
  },
);

it.each(["darwin", "win32"] as const)(
  "still requires matching accessibility screen positions on %s",
  async (platform) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
    const window = {
      name: "Editor",
      bounds: { x: 0, y: 0, width: 700, height: 520 },
      tree,
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });
    try {
      assert.isUndefined(
        await readAccessibleWindowText(
          {
            title: "Editor",
            bounds: { x: 479, y: 342, width: 700, height: 520 },
            owner: { processId: 123 },
          },
          platform,
          "Editor",
        ),
      );
      assert.lengthOf(tree.mock.calls, 0);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each([
  { names: ["⠙ t3code"], expected: "Verified text" },
  { names: ["⠋ t3code", "⠙ t3code"], expected: undefined },
])("reads a changing Wayland title only when unambiguous: $names", async ({ names, expected }) => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const tree = vi.fn(async () => ({ value: "Verified text", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () =>
      names.map((name) => ({
        name,
        bounds: { x: 0, y: 0, width: 700, height: 520 },
        tree,
      })),
  });
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "⠋ t3code",
          bounds: { x: 479, y: 342, width: 700, height: 520 },
          owner: { processId: 123 },
        },
        "linux",
        "⠋ t3code",
      ),
      expected,
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[123, { timeout: 0 }]]);
    assert.lengthOf(tree.mock.calls, expected ? 1 : 0);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([20, 1_350, 2_999])(
  "includes accessibility text as soon as a %d ms read completes",
  async (duration) => {
    vi.useFakeTimers();
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const tree = Promise.withResolvers<{ value: string; children: Array<never> }>();
    const started = Promise.withResolvers<void>();
    accessibilityByPidMock.mockReset().mockResolvedValue({
      children: async () => [
        {
          name: "Mozilla Firefox",
          bounds: { x: 0, y: 0, width: 1_373, height: 928 },
          tree: () => {
            started.resolve();
            return tree.promise;
          },
        },
      ],
    });

    try {
      const result = readAccessibleWindowText(
        {
          title: "Mozilla Firefox",
          owner: { processId: 42 },
          bounds: { x: 67, y: 32, width: 1_373, height: 928 },
        },
        "linux",
        "Mozilla Firefox",
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(duration);
      tree.resolve({ value: "Firefox page text", children: [] });

      assert.strictEqual(await result, "Firefox page text");
      assert.strictEqual(vi.getTimerCount(), 0);
    } finally {
      tree.resolve({ value: "", children: [] });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  },
);

it("falls back to completed flat text when rich traversal reaches the deadline", async () => {
  vi.useFakeTimers();
  const richChildren = Promise.withResolvers<Array<never>>();
  const richStarted = Promise.withResolvers<void>();
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        tree: async () => ({ value: "Complete flat text", children: [] }),
        children: () => {
          richStarted.resolve();
          return richChildren.promise;
        },
      },
    ],
  });

  try {
    const result = readAccessibleWindowContext(
      {
        title: "Editor",
        owner: { processId: 42 },
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      "darwin",
      "Editor",
      { width: 1_600, height: 1_200 },
    );
    await richStarted.promise;
    await vi.advanceTimersByTimeAsync(3_000);

    assert.deepEqual(await result, {
      accessibleText: "Complete flat text",
      accessibility: {
        format: "flat-text",
        text: "Complete flat text",
        truncated: false,
      },
    });
  } finally {
    richChildren.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("times out after three seconds without overlapping the outstanding accessibility read", async () => {
  vi.useFakeTimers();
  accessibilityByPidMock.mockReset();
  const read = Promise.withResolvers<{ children: () => Promise<Array<never>> }>();
  const started = Promise.withResolvers<void>();
  accessibilityByPidMock.mockImplementationOnce(() => {
    started.resolve();
    return read.promise;
  });
  const active = {
    title: "main.ts",
    owner: { processId: 42 },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  } satisfies SnapShotAccessibility.AccessibleWindowIdentity;

  try {
    const first = readAccessibleWindowText(active, "darwin", "main.ts");
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(2_999);
    assert.isFalse(settled);
    await vi.advanceTimersByTimeAsync(1);
    assert.isUndefined(await first);
    assert.strictEqual(vi.getTimerCount(), 0);
    assert.isUndefined(await readAccessibleWindowText(active, "darwin", "main.ts"));
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 1);

    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    accessibilityByPidMock.mockResolvedValueOnce({ children: async () => [] });
    assert.isUndefined(await readAccessibleWindowText(active, "darwin", "main.ts"));
    assert.strictEqual(accessibilityByPidMock.mock.calls.length, 2);
  } finally {
    read.resolve({ children: async () => [] });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("uses native opacity for a short-lived flash", async () => {
  vi.useFakeTimers();
  flashWindows.length = 0;
  const flash = new DesktopSnapShot.SnapShotFlash();
  const bounds = { x: 10, y: 20, width: 800, height: 600 };

  try {
    await flash.showAnimated(bounds);

    assert.lengthOf(flashWindows, 1);
    assert.strictEqual(flashWindows[0]?.kind, "base");
    assert.strictEqual(flashWindows[0]?.options.transparent, false);
    assert.strictEqual(flashWindows[0]?.loadCount, 0);
    assert.deepEqual(flashWindows[0]?.bounds, bounds);
    assert.strictEqual(flashWindows[0]?.showCount, 1);
    assert.lengthOf(flashWindows[0]?.scripts ?? [], 0);
    await vi.advanceTimersByTimeAsync(180);
    assert.isTrue(flashWindows[0]?.destroyed);
    assert.isAbove(flashWindows[0]?.opacities.length ?? 0, 1);
    assert.strictEqual(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

it.effect("does not request permissions or create the flash during desktop startup", () => {
  flashWindows.length = 0;
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotFlash: true,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.initialize;
      assert.lengthOf(flashWindows, 0);
      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(testLayer("darwin", {}, Option.some(settings))));
});

it.effect("keeps snapshots disabled when client settings cannot be read at startup", () => {
  const readError = new DesktopClientSettings.DesktopClientSettingsReadError({
    operation: "read-file",
    path: "/state/client-settings.json",
    cause: new Error("unavailable"),
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.initialize;
      assert.isFalse((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("win32", {}, Option.none(), Effect.fail(readError))));
});

it.effect("does not request macOS permissions while synchronizing enabled settings", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[false]]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(openExternalMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("requests macOS permissions only for an explicit enable action", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.requestPermissions(true);

      assert.deepEqual(accessibilityTrustedMock.mock.calls, [[true]]);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("does not request macOS accessibility permission when capture data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("not-determined");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.requestPermissions(false);

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("reports macOS permission status and requests each permission on its own", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  getSourcesMock.mockReset().mockResolvedValue([]);
  openExternalMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const state = yield* service.state;
      assert.deepEqual(state.macPermissions, { screenRecording: true, accessibility: false });

      yield* service.setup("allow-accessibility");
      assert.deepEqual(accessibilityTrustedMock.mock.calls.at(-1), [true]);
      assert.lengthOf(getSourcesMock.mock.calls, 0);

      mediaAccessStatusMock.mockReturnValue("not-determined");
      yield* service.setup("allow-screen-recording");
      assert.lengthOf(getSourcesMock.mock.calls, 1);
      assert.lengthOf(openExternalMock.mock.calls, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("flags revoked macOS permissions on read and re-registers once they return", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(true);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true });
      assert.isNull((yield* service.state).message);

      mediaAccessStatusMock.mockReturnValue("denied");
      const revoked = yield* service.state;
      assert.equal(
        revoked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.deepEqual(revoked.macPermissions, { screenRecording: false, accessibility: true });

      accessibilityTrustedMock.mockReturnValue(false);
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
      });
      const blocked = yield* service.state;
      assert.equal(
        blocked.message,
        "Allow Screen Recording in System Settings, then restart T3 Code.",
      );
      assert.isFalse(blocked.shortcutRegistered);

      mediaAccessStatusMock.mockReturnValue("granted");
      const recovered = yield* service.state;
      assert.isNull(recovered.message);
      assert.isTrue(recovered.shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("rejects macOS permission actions off macOS and omits macPermissions there", () => {
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const state = yield* service.state;
      assert.isUndefined(state.macPermissions);
      assert.isTrue(state.windows);
      const error = yield* service.setup("allow-screen-recording").pipe(Effect.flip);
      assert.equal(error.reason, "unsupported-session");
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("registers macOS capture without accessibility permission when data is disabled", () => {
  accessibilityTrustedMock.mockReset().mockReturnValue(false);
  mediaAccessStatusMock.mockReset().mockReturnValue("granted");
  registerShortcutMock.mockReset().mockReturnValue(true);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({
        ...DEFAULT_CLIENT_SETTINGS,
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
      });

      assert.lengthOf(accessibilityTrustedMock.mock.calls, 0);
      assert.isTrue((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("starts the Shift listener outside the Electron main process", () => {
  shortcutForkArgs.length = 0;
  shortcutForkOptions.length = 0;
  shortcutProcesses.length = 0;
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      const state = yield* service.state;

      assert.isTrue(state.shortcutRegistered);
      assert.lengthOf(shortcutProcesses, 1);
      assert.deepEqual(shortcutForkArgs[0], ["shift"]);
      assert.strictEqual(shortcutForkOptions[0]?.env?.ELECTRON_RUN_AS_NODE, "1");

      shortcutProcesses[0]?.emit("exit", 1);
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      assert.isFalse((yield* service.state).shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("passes the configured modifier pair to the listener process", () => {
  shortcutForkArgs.length = 0;
  shortcutProcesses.length = 0;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
  } satisfies ClientSettings;

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      const state = yield* service.state;

      assert.isTrue(state.shortcutRegistered);
      assert.deepEqual(shortcutForkArgs[0], ["meta"]);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("registers a configured key chord instead of the Shift listener", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  shortcutProcesses.length = 0;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      assert.isTrue((yield* service.state).shortcutRegistered);
      assert.strictEqual(registerShortcutMock.mock.calls[0]?.[0], "Control+Alt+K");
      assert.lengthOf(shortcutProcesses, 0);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("an unrelated client-setting change keeps the registered shortcut", () => {
  registerShortcutMock.mockReset().mockReturnValue(true);
  unregisterShortcutMock.mockReset();
  const settings = enabledSettings({
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K"],
      );

      yield* service.configure({ ...settings, wordWrap: !settings.wordWrap });
      assert.lengthOf(unregisterShortcutMock.mock.calls, 0);
      assert.lengthOf(registerShortcutMock.mock.calls, 1);
      assert.isTrue((yield* service.state).shortcutRegistered);

      yield* service.configure({
        ...settings,
        snapShotShortcut: { ...settings.snapShotShortcut, key: "j" },
      });
      assert.deepEqual(unregisterShortcutMock.mock.calls, [["Control+Alt+K"]]);
      assert.deepEqual(
        registerShortcutMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+K", "Control+Alt+J"],
      );
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("capture fails closed while snapshots are disabled", () => {
  activeWindowMock.mockClear();
  getSourcesMock.mockClear();
  regionCaptureMock.mockClear();

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: false });
      const failure = yield* Effect.flip(service.capture);
      assert.equal(failure.operation, "disabled");
      assert.lengthOf(activeWindowMock.mock.calls, 0);
      assert.lengthOf(getSourcesMock.mock.calls, 0);
      assert.lengthOf(regionCaptureMock.mock.calls, 0);
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("keeps shortcut registration errors off the capture status", () => {
  registerShortcutMock.mockReset().mockReturnValue(false);
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.isNull(state.message);
      assert.equal(
        state.shortcutMessage,
        "This shortcut is already used by the system or another app.",
      );
    }),
  ).pipe(Effect.provide(testLayer("win32")));
});

it.effect("uses an external Niri shortcut without registering an Electron accelerator", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "niri");
  vi.stubEnv("NIRI_SOCKET", "/test/niri.sock");
  registerShortcutMock.mockReset();
  niriShortcutStopMock.mockReset();
  niriShortcutMock.mockReset().mockResolvedValue(niriShortcutStopMock);
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      const state = yield* service.state;
      assert.isFalse(state.shortcutRegistered);
      assert.include(state.shortcutBinding, "gdbus");
      assert.match(state.shortcutBinding ?? "", /^Ctrl\+Shift\+2 repeat=false \{/);
      assert.include(state.shortcutMessage, "Niri config");
      assert.isTrue(state.shortcutActionRegistered);
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.lengthOf(niriShortcutMock.mock.calls, 1);
      assert.isFalse((yield* service.checkShortcut(settings.snapShotShortcut)).available);
      yield* Effect.promise(async () => {
        await niriShortcutMock.mock.calls[0]![1]();
      });
      assert.isTrue((yield* service.state).shortcutVerified);
      yield* service.configure({ ...settings, snapShotEnabled: false });
      assert.lengthOf(niriShortcutStopMock.mock.calls, 1);
      assert.isUndefined((yield* service.state).shortcutBinding);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("defers ordinary Wayland shortcut registration until settings are applied", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(false);

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const conflict = yield* service.checkShortcut({
        key: "c",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        modKey: false,
      });
      const available = yield* service.checkShortcut({
        key: "2",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        modKey: false,
      });
      assert.isFalse(conflict.available);
      assert.isTrue(available.available);
      assert.match(available.message ?? "", /desktop will confirm/);

      const pair = yield* service.checkShortcut({
        kind: "modifier-pair",
        modifier: "meta",
      });
      assert.isFalse(pair.available);
      assert.match(pair.message ?? "", /Modifier-pair shortcuts aren't available/);
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect.each(["GNOME", "KDE", "niri", "Hyprland"] as const)(
  "identifies %s in setup even when its capability check fails",
  (desktop) => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
    linuxBackendMock.mockRejectedValueOnce(new Error("Capability check failed"));
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        const state = yield* service.state;
        assert.equal(state.linuxDesktop, desktop.toLowerCase());
        assert.equal(state.message, "Capability check failed");
        assert.isFalse(state.shortcutVerified);
      }),
    ).pipe(
      Effect.provide(testLayer("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect(
  "keeps saved preferences but rechecks access and shortcut delivery after changing desktops",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    vi.stubEnv("NIRI_SOCKET", "/test/niri.sock");
    vi.stubEnv("FLATPAK_ID", "");
    vi.stubEnv("SNAP", "");
    registerShortcutMock.mockReset().mockReturnValue(true);
    niriShortcutMock.mockReset().mockResolvedValue(niriShortcutStopMock);
    const settings: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
      snapShotPlaySound: false,
      snapShotAnimations: false,
    };
    return Effect.gen(function* () {
      for (const [desktop, backend] of [
        ["GNOME", "gnome-extension"],
        ["niri", "niri"],
        ["KDE", "kde"],
        ["Hyprland", "hyprland"],
        ["GNOME", "gnome-extension"],
      ] as const) {
        vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
        linuxBackendMock.mockResolvedValue(backend);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* DesktopSnapShot.make;
            yield* service.initialize;
            const state = yield* service.state;
            assert.equal(state.linuxDesktop, desktop.toLowerCase());
            assert.equal(state.linuxBackend, backend);
            assert.deepEqual(state.shortcut, settings.snapShotShortcut);
            assert.isFalse(state.shortcutVerified);
            assert.equal(state.gnomeExtension?.status, desktop === "GNOME" ? "enabled" : undefined);
            assert.equal(state.kdeHelper?.status, desktop === "KDE" ? "not-installed" : undefined);
            assert.equal(
              state.hyprlandHelper?.status,
              desktop === "Hyprland" ? "not-installed" : undefined,
            );
            assert.equal(
              Boolean(state.shortcutBinding),
              desktop === "niri" || desktop === "Hyprland",
            );
            const trigger =
              desktop === "niri"
                ? niriShortcutMock.mock.calls.at(-1)![1]
                : portalShortcutInstances.at(-1)!.onCapture;
            yield* Effect.promise(async () => {
              await trigger();
            });
            assert.isTrue((yield* service.state).shortcutVerified);
          }),
        ).pipe(Effect.provide(testLayer("linux", {}, Option.some(settings))));
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          linuxBackendMock.mockResolvedValue("picker");
          vi.unstubAllEnvs();
        }),
      ),
    );
  },
);

it.effect("does not register a Wayland modifier-pair shortcut when enabled", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(true);
  const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.isFalse(state.shortcutRegistered);
      assert.deepEqual(state.shortcut, DEFAULT_CLIENT_SETTINGS.snapShotShortcut);
      assert.match(state.shortcutMessage ?? "", /Modifier-pair shortcuts aren't available/);
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("exposes pending portal permission and then the real assigned shortcut", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  registerShortcutMock.mockReset().mockReturnValue(true);
  nextPortalState.value = {
    shortcutRegistered: false,
    shortcutPending: true,
    shortcutMessage: "Waiting for permission",
  };
  const shortcut = {
    key: "2",
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    modKey: false,
  } as const;
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotShortcut: shortcut,
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);

      const state = yield* service.state;
      assert.lengthOf(registerShortcutMock.mock.calls, 0);
      assert.isFalse(state.shortcutRegistered);
      assert.isTrue(state.shortcutPending);
      assert.deepEqual(state.shortcut, shortcut);
      assert.equal(state.shortcutMessage, "Waiting for permission");

      portalShortcutInstances[0]!.state = {
        shortcutRegistered: true,
        shortcutPending: false,
        shortcutLabel: "Ctrl+Shift+7",
        shortcutMessage: null,
      };
      assert.equal((yield* service.state).shortcutLabel, "Ctrl+Shift+7");
      assert.isTrue((yield* service.state).shortcutRegistered);
      portalShortcutInstances[0]!.state = {
        shortcutRegistered: false,
        shortcutPending: false,
        shortcutMessage: "Permission denied",
      };
      const failed = yield* service.state;
      assert.isFalse(failed.shortcutRegistered);
      assert.equal(failed.shortcutMessage, "Permission denied");
    }),
  ).pipe(
    Effect.provide(testLayer("linux")),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect("verifies only native shortcut delivery and captures normally", () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  vi.stubEnv("XDG_CURRENT_DESKTOP", "test-desktop");
  registerShortcutMock.mockReset().mockReturnValue(true);
  linuxCaptureMock.mockClear().mockResolvedValue({
    png: Buffer.from([1, 2, 3]),
    window: {
      title: "Shortcut capture",
      appName: "Text Editor",
      appIdentifier: "org.kde.kwrite",
      processId: 123,
      bounds: { x: 0, y: 0, width: 700, height: 520 },
    },
  });
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotEnabled: true,
    snapShotIncludeAccessibility: false,
    snapShotShortcut: {
      key: "2",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      modKey: false,
    },
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure(settings);
      assert.isFalse((yield* service.state).shortcutVerified);
      yield* service.capture;
      assert.isFalse((yield* service.state).shortcutVerified);
      linuxCaptureMock.mockClear();
      const trigger = portalShortcutInstances.at(-1)!.onCapture;
      yield* service.setShortcutSuppressed(true);
      yield* Effect.promise(trigger);
      assert.isFalse((yield* service.state).shortcutVerified);
      assert.lengthOf(linuxCaptureMock.mock.calls, 0);
      yield* service.setShortcutSuppressed(false);
      yield* Effect.promise(trigger);
      assert.isTrue((yield* service.state).shortcutVerified);
      assert.lengthOf(linuxCaptureMock.mock.calls, 1);
      yield* service.setup("retry-shortcut");
      assert.equal(portalShortcutInstances.length, 1);
      assert.equal(portalShortcutInstances[0]!.configure.mock.calls.length, 1);
      yield* service.configure({ ...settings, snapShotEnabled: false });
      assert.isFalse((yield* service.state).shortcutVerified);
    }),
  ).pipe(
    Effect.provide(
      testLayer("linux", {
        makeDirectory: () => Effect.void,
        rename: () => Effect.void,
        writeFile: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    ),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  );
});

it.effect(
  "preserves an approved portal session for cosmetic changes and retires it when keys change",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotEnabled: true,
      snapShotShortcut: {
        key: "2",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        modKey: false,
      },
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(settings);
        const first = portalShortcutInstances[0]!;
        yield* Effect.promise(first.onCapture);
        yield* service.configure({
          ...settings,
          snapShotPlaySound: false,
          snapShotFlash: false,
        });
        assert.equal(portalShortcutInstances.length, 1);
        assert.equal(first.close.mock.calls.length, 0);
        assert.isTrue((yield* service.state).shortcutVerified);
        yield* service.configure({
          ...settings,
          snapShotShortcut: { ...settings.snapShotShortcut, key: "8" },
        });
        assert.equal(first.close.mock.calls.length, 1);
        assert.equal(portalShortcutInstances.length, 2);
        assert.isFalse((yield* service.state).shortcutVerified);
        yield* Effect.promise(first.onCapture);
        assert.isFalse((yield* service.state).shortcutVerified);
        const current = portalShortcutInstances[1]!;
        yield* Effect.promise(current.onCapture);
        assert.isTrue((yield* service.state).shortcutVerified);
        yield* service.configure({ ...settings, snapShotEnabled: false });
        assert.equal(current.close.mock.calls.length, 1);
        yield* Effect.promise(current.onCapture);
        assert.isFalse((yield* service.state).shortcutVerified);
        assert.isFalse((yield* service.state).shortcutRegistered);
      }),
    ).pipe(
      Effect.provide(testLayer("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect(
  "keeps Hyprland's stable action with a modifier-pair preference and releases it when disabled",
  () => {
    vi.stubEnv("XDG_SESSION_TYPE", "wayland");
    vi.stubEnv("XDG_CURRENT_DESKTOP", "Hyprland");
    vi.stubEnv("FLATPAK_ID", "");
    vi.stubEnv("SNAP", "");
    nextPortalState.value = {
      shortcutRegistered: false,
      shortcutActionRegistered: true,
      shortcutPending: false,
      shortcutMessage: "Managed by Hyprland",
    };
    const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(settings);
        assert.lengthOf(portalShortcutInstances, 1);
        const first = portalShortcutInstances[0]!;
        assert.isTrue((yield* service.state).shortcutActionRegistered);
        const check = yield* service.checkShortcut(settings.snapShotShortcut);
        assert.isFalse(check.available);
        assert.include(check.message, "Hyprland config");
        yield* service.configure({ ...settings, snapShotPlaySound: false });
        assert.lengthOf(portalShortcutInstances, 1);
        assert.lengthOf(first.close.mock.calls, 0);
        yield* service.configure({ ...settings, snapShotEnabled: false });
        assert.lengthOf(first.close.mock.calls, 1);
        assert.notEqual((yield* service.state).shortcutActionRegistered, true);
      }),
    ).pipe(
      Effect.provide(testLayer("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

it.effect("advises about the system menu for a meta pair on Windows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const result = yield* service.checkShortcut({ kind: "modifier-pair", modifier: "meta" });
      assert.isTrue(result.available);
      assert.match(result.message ?? "", /Super \+ Super is observed/);
      assert.match(result.message ?? "", /system's own menu/);
    }),
  ).pipe(Effect.provide(testLayer("win32"))),
);

it.effect("probes macOS modifier pairs with the flags poller", () => {
  spawnedPollers.length = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const result = yield* service.checkShortcut({ kind: "both-shift-keys" });
      assert.isTrue(result.available);
      assert.match(result.message ?? "", /Shift \+ Shift is observed/);
      assert.notMatch(result.message ?? "", /Input Monitoring/);
      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["2", "4"]);
      assert.strictEqual(spawnedPollers[0]?.kill.mock.calls.length, 1);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("registers macOS modifier pairs through the flags poller", () => {
  spawnedPollers.length = 0;
  shortcutProcesses.length = 0;
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValue("granted");
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
  } satisfies ClientSettings;

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      yield* service.configure({ ...settings, snapShotEnabled: true });
      const state = yield* service.state;

      assert.lengthOf(shortcutProcesses, 0);
      assert.lengthOf(spawnedPollers, 1);
      assert.deepEqual(spawnedPollers[0]?.args.slice(-2), ["8", "16"]);
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(testLayer("darwin")));
});

it.effect("waits to apply settings while permissions are pending", () => {
  accessibilityTrustedMock.mockReturnValue(true);
  mediaAccessStatusMock.mockReturnValueOnce("not-determined").mockReturnValue("granted");
  let finishPermissionRequest: (() => void) | undefined;
  getSourcesMock.mockImplementationOnce(
    () =>
      new Promise<Array<never>>((resolve) => {
        finishPermissionRequest = () => resolve([]);
      }),
  );
  const layer = testLayer("darwin");

  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const enabled = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
      const permissionFiber = yield* service.requestPermissions(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      if (!finishPermissionRequest) throw new Error("Permission request did not start");
      const finishPermission = finishPermissionRequest;

      const configureFiber = yield* service.configure(enabled).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isFalse((yield* service.state).shortcutRegistered);
      finishPermission();
      yield* Fiber.join(permissionFiber);
      yield* Fiber.join(configureFiber);

      const state = yield* service.state;
      assert.isTrue(state.shortcutRegistered);
    }),
  ).pipe(Effect.provide(layer));
});

for (const fails of [false, true]) {
  it.effect(`tests macOS capture without publishing it and cleans up, failure=${fails}`, () => {
    const active = {
      platform: "macos",
      id: 42,
      title: "Setup",
      owner: { name: "T3 Code", processId: 123, path: "/Applications/T3 Code.app" },
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    activeWindowMock.mockReset().mockResolvedValue(active);
    macCaptureMock.mockReset();
    if (fails) macCaptureMock.mockRejectedValue(new Error("Capture denied"));
    else macCaptureMock.mockResolvedValue({ source: { name: "Setup" }, png: Buffer.from("png") });
    accessibilityProcessReadMock.mockClear();
    const cleanup = vi.fn();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        if (fails) {
          const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
          assert.equal(error.reason, "setup-failed");
        } else yield* service.setup("test-mac-capture");
        assert.equal(macCaptureMock.mock.calls.length, 1);
        assert.equal(macCaptureMock.mock.calls[0]?.[0], active);
        assert.equal(macCaptureMock.mock.calls[0]?.[1], "/tmp/setup-test/test.png");
        assert.equal(cleanup.mock.calls.length, 1);
        assert.equal(accessibilityProcessReadMock.mock.calls.length, 0);
        assert.deepEqual(yield* service.listPending, []);
      }),
    ).pipe(
      Effect.provide(
        testLayer("darwin", {
          makeTempDirectoryScoped: () =>
            Effect.acquireRelease(Effect.succeed("/tmp/setup-test"), () =>
              Effect.sync(() => {
                cleanup();
              }),
            ),
          readDirectory: () => Effect.succeed([]),
        }),
      ),
    );
  });
}

it.effect("rejects macOS test capture on other platforms", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* DesktopSnapShot.make;
      const error = yield* service.setup("test-mac-capture").pipe(Effect.flip);
      assert.equal(error.reason, "unsupported-session");
    }),
  ).pipe(Effect.provide(testLayer("win32"))),
);
