import * as MacPermissions from "../permissions/MacPermissions.ts";
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
  accessibilityListMock.mockReset().mockResolvedValue([]);
});

const {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessWarmMock,
  accessibilityProcessCloseMock,
  accessibilityProcessCoolMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityListMock,
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
  accessibilityListMock: vi.fn(),
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

const accessibilityApp = {
  byPid: accessibilityByPidMock,
  list: accessibilityListMock,
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

import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";
const layerTest = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
  settingsGet: Effect.Effect<
    Option.Option<ClientSettings>,
    DesktopClientSettings.DesktopClientSettingsReadError
  > = Effect.succeed(initialSettings),
) =>
  MacPermissions.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            platform,
            displayName: "T3 Code (Dev)",
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
      ),
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
    layerTest(platform, {
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

it.effect.each(["darwin", "win32"] as const)(
  "drops shortcut bursts during flight and accepts a fresh capture after landing on %s",
  (platform) => {
    const fixture = concurrentCaptureFixture(platform, true);
    fixture.releaseAll();
    const flying = Promise.withResolvers<void>();
    const heldFlights: Array<() => void> = [];
    const push = heldFlights.push.bind(heldFlights);
    vi.spyOn(heldFlights, "push").mockImplementation((...resolvers) => {
      const count = push(...resolvers);
      flying.resolve();
      return count;
    });
    transitionScriptState.heldFlights = heldFlights;
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopSnapShot.make;
        yield* service.configure(fixture.settings);
        yield* Effect.promise(fixture.trigger);
        const firstId = fixture.readyIds[0]!;
        const landing = yield* service
          .setAnimationDestination(firstId, {
            frame: { x: 100, y: 400, width: 208, height: 112 },
            backgroundColor: "#fff",
            borderColor: "#ccc",
            borderWidth: 1,
            cornerRadius: 8,
            scaleFactor: 1,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => flying.promise);
        const overlayCount = flashWindows.length;

        for (let repeat = 0; repeat < 20; repeat++) {
          yield* TestClock.adjust("200 millis");
          yield* Effect.promise(fixture.trigger);
        }
        assert.equal(fixture.state.snapshots, 1);
        assert.lengthOf(fixture.readyIds, 1);
        assert.lengthOf(flashWindows, overlayCount);
        assert.isTrue(flashWindows.every((window) => !window.destroyed));

        for (const finish of heldFlights) finish();
        yield* Fiber.join(landing);
        yield* Effect.promise(fixture.trigger);
        assert.equal(fixture.state.snapshots, 2);
        assert.lengthOf(fixture.readyIds, 2);
        assert.isTrue(fixture.second.oldOverlaysCleared);
      }),
    ).pipe(
      Effect.provide(fixture.layer),
      Effect.ensuring(
        Effect.sync(() => {
          for (const finish of heldFlights) finish();
          transitionScriptState.heldFlights = null;
          fixture.reset();
        }),
      ),
    );
  },
);

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
    const layer = layerTest("darwin", {
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
      layerTest("win32", {
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
        layerTest("linux", {
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
    assert.isFalse(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
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
    assert.isTrue(transition.isAnimating);
    transition.dismiss("capture-1");
    assert.isFalse(transition.isAnimating);
    frame.resolve();
    await landing;

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    frame.resolve();
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
    assert.isFalse(transition.isAnimating);
    await transition.complete("capture-1");

    assert.isTrue(flashWindows[0]?.destroyed);
  } finally {
    transitionScriptState.rejectFlight = false;
    transition.dispose();
  }
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

it.each(["darwin", "win32", "linux"] as const)(
  "extracts the same structured accessibility tree on %s",
  async (platform) => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({
        name: "Editor",
        children: [
          { name: "Save", children: [] },
          { name: "Below scroll view", children: [] },
        ],
      }),
      children: async () => [
        {
          role: "button",
          name: "Save",
          bounds: { x: 300, y: 350, width: 100, height: 50 },
          children: async () => [],
        },
        {
          role: "static_text",
          name: "Below scroll view",
          bounds: { x: 300, y: 1_000, width: 100, height: 50 },
          visible: false,
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
    assert.deepInclude(
      result?.accessibility?.format === "element-tree"
        ? result.accessibility.root.children[1]
        : undefined,
      { name: "Below scroll view", bounds: null, state: { visible: false } },
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
  ["darwin", "", "value", 650],
  ["linux", "wayland", "value", 650],
  ["darwin", "", "name", 100],
] as const)(
  "preserves long text outside the scroll view on %s %s (%s)",
  async (platform, session, field, lines) => {
    const text = `${"Document line\n".repeat(lines)}End of document`;
    vi.stubEnv("XDG_SESSION_TYPE", session);
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    const window = {
      role: "window",
      name: "Editor",
      bounds,
      tree: async () => ({ name: "Editor", children: [{ [field]: text, children: [] }] }),
      children: async () => [
        { role: "text_area", [field]: text, bounds, children: async () => [] },
      ],
    };
    accessibilityByPidMock.mockReset().mockResolvedValue({ children: async () => [window] });
    accessibilityForegroundMock
      .mockReset()
      .mockResolvedValue({ pid: 123, asElement: () => window });
    try {
      const result = await readAccessibleWindowContext(
        { title: "Editor", bounds, owner: { processId: 123 } },
        platform,
        "Editor",
      );
      assert.deepEqual(result?.accessibility, {
        format: "flat-text",
        text: `Editor\n${text}`,
        truncated: false,
      });
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

it.each([
  ["com.google.Chrome", "Google Chrome – Profile"],
  ["org.chromium.Chromium", "Chromium"],
])("reads macOS %s page context with an accessibility title suffix", async (bundleId, suffix) => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const window = {
    role: "window",
    name: `${title} - ${suffix}`,
    bounds,
    tree: async () => ({ name: title, children: [{ name: "New issue", children: [] }] }),
    children: async () => [{ role: "button", name: "New issue", bounds, children: async () => [] }],
  };
  accessibilityByPidMock.mockReset().mockImplementation(async (pid: number) => ({
    children: async () => (pid === 42 ? [window] : []),
  }));

  const context = await readAccessibleWindowContext(
    { title, bounds, owner: { processId: 42, bundleId } },
    "darwin",
    title,
  );

  assert.equal(context?.accessibleText, `${title}\nNew issue`);
  assert.equal(context?.accessibility?.format, "element-tree");
  assert.equal(
    context?.accessibility?.format === "element-tree"
      ? context.accessibility.root.children[0]?.name
      : undefined,
    "New issue",
  );
});

it("does not borrow another Chrome process context when the captured PID has no windows", async () => {
  const title = "Issues · pingdotgg/t3code";
  const bounds = { x: 0, y: 33, width: 1470, height: 857 };
  const otherWindow = {
    role: "window",
    name: `${title} - Google Chrome – Profile`,
    bounds,
    tree: async () => ({
      name: title,
      children: [{ name: "Other process private text", children: [] }],
    }),
    children: async () => [],
  };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    pid: 42,
    children: async () => [],
  });
  accessibilityListMock.mockResolvedValue([
    { pid: 43, bundleId: "com.google.Chrome", children: async () => [otherWindow] },
  ]);

  assert.isUndefined(
    await readAccessibleWindowContext(
      { title, bounds, owner: { processId: 42, bundleId: "com.google.Chrome" } },
      "darwin",
      title,
    ),
  );
});

it("reads Flatpak app text from the AT-SPI proxy when the compositor PID misses", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "Issue — Zen Browser",
    children: [{ name: "New Tab", children: [] }],
  }));
  const proxyWindow = {
    role: "window",
    name: "Issue — Zen Browser",
    bounds,
    tree,
    children: async () => [],
  };
  accessibilityByPidMock
    .mockReset()
    .mockRejectedValue(
      new Error("XA11Y_SELECTOR_NOT_MATCHED: No element matched selector: application[pid=207651]"),
    );
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 1,
      children: async () => [
        {
          role: "window",
          name: "Files",
          bounds,
          tree: async () => ({ name: "Files", children: [] }),
        },
      ],
    },
    { pid: 207646, children: async () => [proxyWindow] },
  ]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "Issue — Zen Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_048 },
          owner: { processId: 207651 },
        },
        "linux",
        "Issue — Zen Browser",
      ),
      "Issue — Zen Browser\nNew Tab",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[207651, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 1);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("reads GTK4 app text from one unnamed PID-scoped window of the captured size", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({
    name: "System Monitor",
    children: [{ name: "CPU", children: [] }],
  }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "group",
        name: null,
        bounds,
        tree,
        children: async () => [
          { role: "page_tab_list", name: "Processes", bounds, children: async () => [] },
        ],
      },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([]);
  try {
    assert.strictEqual(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds: { x: 12, y: 48, width: 1_920, height: 1_048 },
          owner: { processId: 210600 },
        },
        "linux",
        "System Monitor",
      ),
      "System Monitor\nCPU",
    );
    assert.deepEqual(accessibilityByPidMock.mock.calls, [[210600, { timeout: 0 }]]);
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 1);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("does not guess GTK4 app text when two unnamed PID windows share the captured size", async () => {
  vi.stubEnv("XDG_SESSION_TYPE", "wayland");
  const bounds = { x: 0, y: 0, width: 1_920, height: 1_048 };
  const tree = vi.fn(async () => ({ value: "Wrong window", children: [] }));
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      { role: "group", name: null, bounds, tree },
      { role: "group", name: null, bounds: { ...bounds, x: 12 }, tree },
    ],
  });
  accessibilityListMock.mockReset().mockResolvedValue([
    {
      pid: 99,
      children: async () => [{ role: "window", name: "System Monitor", bounds, tree }],
    },
  ]);
  try {
    assert.isUndefined(
      await readAccessibleWindowText(
        {
          title: "System Monitor",
          bounds: { x: 12, y: 48, width: 1_920, height: 1_048 },
          owner: { processId: 210600 },
        },
        "linux",
        "System Monitor",
      ),
    );
    assert.lengthOf(accessibilityListMock.mock.calls, 0);
    assert.lengthOf(tree.mock.calls, 0);
  } finally {
    accessibilityListMock.mockReset().mockResolvedValue([]);
    vi.unstubAllEnvs();
  }
});

it("keeps a truncated element tree when the flat text read fails", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  accessibilityByPidMock.mockReset().mockResolvedValue({
    children: async () => [
      {
        role: "window",
        name: "Editor",
        bounds,
        tree: async () => {
          throw new Error("Text read failed");
        },
        children: async () => [
          {
            role: "text_area",
            value: "x".repeat(8_001),
            bounds: { x: 10, y: 50, width: 700, height: 500 },
            children: async () => [],
          },
        ],
      },
    ],
  });

  const result = await readAccessibleWindowContext(
    { title: "Editor", bounds, owner: { processId: 123 } },
    "darwin",
    "Editor",
  );
  assert.equal(result?.accessibility?.format, "element-tree");
  assert.isTrue(result?.accessibility?.truncated);
  assert.deepEqual(
    result?.accessibility?.format === "element-tree"
      ? result.accessibility.root.children[0]?.bounds
      : undefined,
    { x: 10, y: 50, width: 700, height: 500 },
  );
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
  ).pipe(Effect.provide(layerTest("darwin")));
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
  ).pipe(Effect.provide(layerTest("win32")));
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
  ).pipe(Effect.provide(layerTest("win32")));
});

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
        ).pipe(Effect.provide(layerTest("linux", {}, Option.some(settings))));
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
      layerTest("linux", {
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
      Effect.provide(layerTest("linux")),
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
      Effect.provide(layerTest("linux")),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

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
  const layer = layerTest("darwin");

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

it.effect.each([false, true])(
  "tests macOS capture without publishing it and cleans up, failure=%s",
  (fails) => {
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
          assert.equal(
            error.message,
            'Could not capture a test snapshot. Capturing the window failed. macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "T3 Code (Dev)" is allowed for both.',
          );
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
        layerTest("darwin", {
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
  },
);
