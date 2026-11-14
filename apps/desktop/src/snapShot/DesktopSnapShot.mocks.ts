// @effect-diagnostics nodeBuiltinImport:off - the mocks mirror Node built-ins for the snap shot tests.
import { beforeEach, vi } from "vite-plus/test";
import type { PortalShortcutState } from "./PortalCaptureShortcut.ts";
import type { Mock } from "vite-plus/test";


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


const mockState = vi.hoisted(() => ({
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

export const activeWindowMock = mockState.activeWindowMock as Mock<(...args: any[]) => any>;
export const animationSettingsMock = mockState.animationSettingsMock as Mock<(...args: any[]) => any>;
export const accessibilityProcessWarmMock = mockState.accessibilityProcessWarmMock as Mock<(...args: any[]) => any>;
export const accessibilityProcessCloseMock = mockState.accessibilityProcessCloseMock as Mock<(...args: any[]) => any>;
export const accessibilityProcessCoolMock = mockState.accessibilityProcessCoolMock as Mock<(...args: any[]) => any>;
export const accessibilityProcessReadMock = mockState.accessibilityProcessReadMock as Mock<(...args: any[]) => any>;
export const accessibilityByPidMock = mockState.accessibilityByPidMock as Mock<(...args: any[]) => any>;
export const accessibilityListMock = mockState.accessibilityListMock as Mock<(...args: any[]) => any>;
export const accessibilityForegroundMock = mockState.accessibilityForegroundMock as Mock<(...args: any[]) => any>;
export const accessibilityTrustedMock = mockState.accessibilityTrustedMock as Mock<(...args: any[]) => any>;
export const allWindowsMock = mockState.allWindowsMock as Mock<(...args: any[]) => any>;
export const focusedWindowMock = mockState.focusedWindowMock as Mock<(...args: any[]) => any>;
export const getFileIconMock = mockState.getFileIconMock as Mock<(...args: any[]) => any>;
export const getSourcesMock = mockState.getSourcesMock as Mock<(...args: any[]) => any>;
export const macCaptureMock = mockState.macCaptureMock as Mock<(...args: any[]) => any>;
export const linuxCaptureMock = mockState.linuxCaptureMock as Mock<(...args: any[]) => any>;
export const linuxBackendMock = mockState.linuxBackendMock as Mock<(...args: any[]) => any>;
export const niriShortcutMock = mockState.niriShortcutMock as Mock<(...args: any[]) => any>;
export const niriShortcutStopMock = mockState.niriShortcutStopMock as Mock<(...args: any[]) => any>;
export const mediaAccessStatusMock = mockState.mediaAccessStatusMock as Mock<(...args: any[]) => any>;
export const openExternalMock = mockState.openExternalMock as Mock<(...args: any[]) => any>;
export const registerShortcutMock = mockState.registerShortcutMock as Mock<(...args: any[]) => any>;
export const unregisterShortcutMock = mockState.unregisterShortcutMock as Mock<(...args: any[]) => any>;
export const prepareCaptureRevealMock = mockState.prepareCaptureRevealMock as Mock<(...args: any[]) => any>;
export const regionCaptureMock = mockState.regionCaptureMock as Mock<(...args: any[]) => any>;
export const screenToDipRectMock = mockState.screenToDipRectMock as Mock<(...args: any[]) => any>;
export const thumbnailFromPathMock = mockState.thumbnailFromPathMock as Mock<(...args: any[]) => any>;
export const transitionCapturePageMock = mockState.transitionCapturePageMock as Mock<(...args: any[]) => any>;
export const transitionShowMock = mockState.transitionShowMock as Mock<(...args: any[]) => any>;
export const transitionSnapshotMock = mockState.transitionSnapshotMock as Mock<(...args: any[]) => any>;
export const flashWindows = mockState.flashWindows;
export const portalShortcutInstances = mockState.portalShortcutInstances;
export const nextPortalState = mockState.nextPortalState;
export const shortcutForkArgs = mockState.shortcutForkArgs;
export const shortcutForkOptions = mockState.shortcutForkOptions;
export const shortcutProcesses = mockState.shortcutProcesses;
export const spawnedPollers = mockState.spawnedPollers;
export const transitionScriptState = mockState.transitionScriptState;
