import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
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
  /** sha512 of a download an earlier launch left in electron-updater's cache. */
  readonly cachedDownloadSha512?: string;
  readonly cachedDownloadInfo?: string;
  readonly cachedFileExists?: boolean;
  readonly updater?: ElectronUpdater.ElectronUpdater["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly runningUnderArm64Translation?: boolean;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly backendDesiredRunning?: boolean;
  readonly backendInstances?: ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly processArch?: string;
  readonly packageType?: string | undefined;
  readonly installRecord?: string | undefined;
}

const PENDING_DOWNLOAD_DIRECTORY = "/cache/t3code-updater/pending";

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

  const stubUpdater = {
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
    pendingDownloadDirectory: Effect.succeed(
      options.cachedDownloadSha512 === undefined
        ? Option.none()
        : Option.some(PENDING_DOWNLOAD_DIRECTORY),
    ),
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
  } satisfies ElectronUpdater.ElectronUpdater["Service"];
  const layerUpdater = Layer.succeed(
    ElectronUpdater.ElectronUpdater,
    options.updater ?? stubUpdater,
  );

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
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

  let backendDesiredRunning = options.backendDesiredRunning ?? true;
  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      backendDesiredRunning = true;
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () =>
      Effect.sync(() => {
        backendDesiredRunning = false;
      }).pipe(Effect.andThen(options.stopBackend ?? Effect.void)),
    currentConfig: Effect.succeedNone,
    snapshot: Effect.sync(() => ({
      desiredRunning: backendDesiredRunning,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    })),
    waitForReady: () => Effect.succeed(true),
  };
  const layerBackend = DesktopBackendPool.layerTest(
    options.backendInstances ?? [stubBackendInstance],
  );

  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "darwin",
    processArch: options.processArch ?? "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: options.runningUnderArm64Translation ?? false,
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
  const layerSettings =
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
          setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  const updateRestartMarkers = new Set<string>();
  const installRecords = new Map<string, string>();
  let previousInstallRecord = options.installRecord;
  const isInstallRecord = (path: string) =>
    path.endsWith(DesktopUpdates.DESKTOP_UPDATE_INSTALL_RECORD_FILE);
  const stubFileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      const installRecord = isInstallRecord(path)
        ? (installRecords.get(path) ?? previousInstallRecord)
        : undefined;
      if (installRecord !== undefined) return Effect.succeed(installRecord);
      return path.replaceAll("\\", "/") === "/missing/resources/package-type" &&
        options.packageType !== undefined
        ? Effect.succeed(options.packageType)
        : path === `${PENDING_DOWNLOAD_DIRECTORY}/update-info.json` &&
            options.cachedDownloadSha512 !== undefined
          ? Effect.succeed(
              options.cachedDownloadInfo ??
                JSON.stringify({
                  fileName: "update.zip",
                  sha512: options.cachedDownloadSha512,
                }),
            )
          : Effect.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "readFileString",
                _tag: "NotFound",
                pathOrDescriptor: path,
              }),
            );
    },
    exists: (path) =>
      Effect.succeed(
        options.cachedFileExists !== false && path === `${PENDING_DOWNLOAD_DIRECTORY}/update.zip`,
      ),
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.sync(() => {
        if (isInstallRecord(path)) installRecords.set(path, data);
        else updateRestartMarkers.add(path);
      }),
    remove: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.delete(path);
        installRecords.delete(path);
        if (isInstallRecord(path)) previousInstallRecord = undefined;
      }),
  });

  const layerFileSystem = options.fileSystem
    ? Layer.succeed(FileSystem.FileSystem, options.fileSystem)
    : stubFileSystem;
  const layer = DesktopUpdates.layer.pipe(
    Layer.provide(layerFileSystem),
    Layer.provideMerge(layerUpdater),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    quitAndInstalls: () => quitAndInstallCount,
    installSteps,
    updateRestartMarkers,
    installRecords,
    previousInstallRecord: () => previousInstallRecord,
    downloadCount: () => downloadCount,
    feedUrls: (): ElectronUpdater.ElectronUpdaterFeedUrl[] => feedUrls,
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
