import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

/** Shared DesktopUpdates test harness: a fully stubbed updater layer whose
    electron-updater events are driven by hand via `emit`. Used by
    DesktopUpdates.test.ts and DesktopRemoteUpdates.test.ts. */

export const flushCallbacks = Effect.yieldNow;

export interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly beforeSetUpdateChannel?: Effect.Effect<void>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let quitAndInstallCount = 0;
  let downloadCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.sync(() => {
      downloadCount += 1;
    }).pipe(Effect.andThen(options.downloadUpdate ?? Effect.void)),
    quitAndInstall: () =>
      Effect.sync(() => {
        quitAndInstallCount += 1;
        installSteps.push("quitAndInstall");
      }).pipe(Effect.andThen(options.quitAndInstall ?? Effect.void)),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () => options.stopBackend ?? Effect.void,
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const backendLayer = DesktopBackendPool.layerTest([stubBackendInstance]);

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer =
    setUpdateChannelError || options.beforeSetUpdateChannel
      ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.sync(() => testSettings),
          load: Effect.sync(() => testSettings),
          setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
          setServerExposureMode: () => Effect.die("unexpected server exposure update"),
          setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
          setUpdateChannel: (channel) =>
            setUpdateChannelError
              ? Effect.fail(setUpdateChannelError)
              : (options.beforeSetUpdateChannel ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const changed = testSettings.updateChannel !== channel;
                      testSettings = {
                        ...testSettings,
                        updateChannel: channel,
                        updateChannelConfiguredByUser: true,
                      };
                      return { settings: testSettings, changed };
                    }),
                  ),
                ),
          setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
          setWslDistro: () => Effect.die("unexpected WSL distro change"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    quitAndInstalls: () => quitAndInstallCount,
    installSteps,
    downloadCount: () => downloadCount,
    feedUrls: () => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}
