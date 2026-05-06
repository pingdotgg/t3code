import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectPath from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  ipcMain,
  type MenuItemConstructorOptions,
  Menu,
  nativeTheme,
} from "electron";
import { autoUpdater } from "electron-updater";

import type {
  DesktopServerExposureMode,
  DesktopServerExposureState,
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

import { DEFAULT_DESKTOP_BACKEND_PORT, resolveDesktopBackendPortEffect } from "./backendPort.ts";
import {
  type DesktopSettings,
  DEFAULT_DESKTOP_SETTINGS,
  readDesktopSettingsEffect,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
  setDesktopUpdateChannelPreference,
  writeDesktopSettingsEffect,
} from "./desktopSettings.ts";
import {
  DesktopBackendConfiguration,
  DesktopBackendEvents,
  DesktopBackendManager,
  DesktopBackendManagerLive,
  DesktopBackendProcessRunnerLive,
  type DesktopBackendManagerShape,
  type DesktopBackendStartConfig,
} from "./desktopBackendManager.ts";
import {
  DesktopNetworkInterfacesLive,
  DesktopNetworkInterfacesService,
} from "./desktopNetworkInterfaces.ts";
import {
  DesktopBackendOutputLog,
  DesktopBackendOutputLogLive,
  DesktopLoggerLive,
} from "./desktopLogger.ts";
import {
  DesktopEnvironment,
  makeDesktopEnvironment,
  type DesktopEnvironmentShape,
} from "./desktopEnvironment.ts";
import * as DesktopSecretStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import { DesktopShutdown, makeDesktopShutdown } from "./desktopShutdown.ts";
import { MENU_ACTION_CHANNEL, UPDATE_STATE_CHANNEL } from "./ipc/channels.ts";
import { installDesktopIpcHandlers } from "./ipc/DesktopIpcHandlers.ts";
import { DesktopServerExposureIpcActions } from "./ipc/methods/serverExposure.ts";
import { DesktopUpdateIpcActions } from "./ipc/methods/updates.ts";
import * as DesktopWindowIpcActionsLive from "./ipc/methods/windowLive.ts";
import {
  resolveDesktopCoreAdvertisedEndpoints,
  resolveDesktopServerExposure,
} from "./serverExposure.ts";
import {
  DesktopSshEnvironmentBridge,
  DesktopSshEnvironmentManager,
  type DesktopSshEnvironmentBridgeShape,
  resolveRemoteT3CliPackageSpec,
} from "./sshEnvironment.ts";
import {
  DesktopShellEnvironment,
  DesktopShellEnvironmentConfigLive,
  DesktopShellEnvironmentLive,
  DesktopShellEnvironmentProbeLive,
} from "./syncShellEnvironment.ts";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState.ts";
import { doesVersionMatchDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";
import { isArm64HostRunningIntelBuild } from "./runtimeArch.ts";
import { bindFirstRevealTrigger, type RevealSubscription } from "./windowReveal.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";
import * as DesktopLocalEnvironment from "./main/DesktopLocalEnvironment.ts";
import * as DesktopState from "./main/DesktopState.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.String),
});
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ["0.0.0.0", "::"] as const;
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

type WindowTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
interface BackendObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}
let backendPort = 0;
let backendBindHost = DESKTOP_LOOPBACK_HOST;
let backendBootstrapToken = "";
let backendHttpUrl: Option.Option<URL> = Option.none();
let backendEndpointUrl: string | null = null;
let backendAdvertisedHost: string | null = null;
let appUpdateYmlConfig: Option.Option<Record<string, string>> = Option.none();
let aboutCommitHashCache: Option.Option<string> | undefined;
let desktopIconPaths: Readonly<Record<"ico" | "icns" | "png", Option.Option<string>>> = {
  ico: Option.none(),
  icns: Option.none(),
  png: Option.none(),
};
let appRunId = "startup";
let backendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
};
let desktopSettings = DEFAULT_DESKTOP_SETTINGS;
let desktopServerExposureMode: DesktopServerExposureMode = desktopSettings.serverExposureMode;

interface DesktopEffectRunner {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A>;
}

type DesktopWindowBoundaryServices =
  | DesktopEnvironment
  | DesktopSshEnvironmentBridge
  | ElectronDialog.ElectronDialog
  | ElectronShell.ElectronShell
  | DesktopState.DesktopState
  | ElectronWindow.ElectronWindow;
type DesktopLifecycleBoundaryServices =
  | DesktopShutdown
  | DesktopWindowBoundaryServices
  | ElectronApp.ElectronApp;

function makeDesktopEffectRunner<R>(context: Context.Context<R>): DesktopEffectRunner {
  return <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
    Effect.runPromiseWith(context as unknown as Context.Context<R2>)(effect);
}

function requireBackendHttpUrl(): URL {
  return Option.getOrThrowWith(
    backendHttpUrl,
    () => new Error("Desktop backend HTTP URL has not been resolved."),
  );
}

function getBackendHttpUrlHref(): string | null {
  return Option.match(backendHttpUrl, {
    onNone: () => null,
    onSome: (url) => url.href,
  });
}

const initialUpdateState = (environment: DesktopEnvironmentShape): DesktopUpdateState =>
  createInitialDesktopUpdateState(
    environment.appVersion,
    environment.runtimeInfo,
    desktopSettings.updateChannel,
  );

function nowIsoTimestamp(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

const withDesktopLogAnnotations = (
  effect: Effect.Effect<void>,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> =>
  effect.pipe(
    Effect.annotateLogs({
      scope: "desktop",
      runId: appRunId,
      ...annotations,
    }),
  );

const logDesktopInfo = (
  message: string,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> => withDesktopLogAnnotations(Effect.logInfo(message), annotations);

const logDesktopWarning = (
  message: string,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> => withDesktopLogAnnotations(Effect.logWarning(message), annotations);

const logDesktopError = (
  message: string,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> => withDesktopLogAnnotations(Effect.logError(message), annotations);

const logUpdaterInfo = (
  message: string,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> =>
  withDesktopLogAnnotations(Effect.logInfo(message), {
    component: "desktop-updater",
    ...annotations,
  });

const logUpdaterError = (
  message: string,
  annotations?: Record<string, unknown>,
): Effect.Effect<void> =>
  withDesktopLogAnnotations(Effect.logError(message), {
    component: "desktop-updater",
    ...annotations,
  });

function readPersistedBackendObservabilitySettings(): Effect.Effect<
  BackendObservabilitySettings,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const exists = yield* fileSystem
      .exists(environment.serverSettingsPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    }

    const raw = yield* fileSystem
      .readFileString(environment.serverSettingsPath)
      .pipe(Effect.option);
    if (Option.isNone(raw)) {
      yield* logDesktopWarning("failed to read persisted backend observability settings");
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    }

    return yield* Effect.try({
      try: () => parsePersistedServerObservabilitySettings(raw.value),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        logDesktopWarning("failed to parse persisted backend observability settings", {
          error,
        }).pipe(Effect.as({ otlpTracesUrl: undefined, otlpMetricsUrl: undefined })),
      ),
    );
  });
}

function resolveConfiguredDesktopBackendPort(rawPort: string | undefined): number | undefined {
  if (!rawPort) {
    return undefined;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return undefined;
  }

  return parsedPort;
}

function resolveDesktopDevServerUrl(environment: DesktopEnvironmentShape): string {
  const devServerUrl = Option.getOrUndefined(environment.devServerUrl);
  if (devServerUrl === undefined) {
    throw new Error("VITE_DEV_SERVER_URL is required in desktop development.");
  }

  return devServerUrl;
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.T3CODE_PORT;
  delete env.T3CODE_MODE;
  delete env.T3CODE_NO_BROWSER;
  delete env.T3CODE_HOST;
  delete env.T3CODE_DESKTOP_WS_URL;
  delete env.T3CODE_DESKTOP_LAN_ACCESS;
  delete env.T3CODE_DESKTOP_LAN_HOST;
  delete env.T3CODE_DESKTOP_HTTPS_ENDPOINTS;
  delete env.T3CODE_TAILSCALE_SERVE;
  delete env.T3CODE_TAILSCALE_SERVE_PORT;
  return env;
}

function getDesktopServerExposureState(): DesktopServerExposureState {
  return {
    mode: desktopServerExposureMode,
    endpointUrl: backendEndpointUrl,
    advertisedHost: backendAdvertisedHost,
    tailscaleServeEnabled: desktopSettings.tailscaleServeEnabled,
    tailscaleServePort: desktopSettings.tailscaleServePort,
  };
}

function getDesktopAdvertisedEndpoints() {
  return Effect.gen(function* () {
    const networkInterfaces = yield* (yield* DesktopNetworkInterfacesService).read;
    const exposure = resolveDesktopServerExposure({
      mode: desktopServerExposureMode,
      port: backendPort,
      networkInterfaces,
      ...(backendAdvertisedHost ? { advertisedHostOverride: backendAdvertisedHost } : {}),
    });
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: backendPort,
      exposure,
      customHttpsEndpointUrls: resolveCustomHttpsEndpointUrls(),
    });
    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: backendPort,
      serveEnabled: desktopSettings.tailscaleServeEnabled,
      servePort: desktopSettings.tailscaleServePort,
      networkInterfaces,
    });
    return [...coreEndpoints, ...tailscaleEndpoints];
  });
}

function resolveAdvertisedHostOverride(): string | undefined {
  const override = process.env.T3CODE_DESKTOP_LAN_HOST?.trim();
  return override && override.length > 0 ? override : undefined;
}

function resolveCustomHttpsEndpointUrls(): readonly string[] {
  return (process.env.T3CODE_DESKTOP_HTTPS_ENDPOINTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function applyDesktopServerExposureMode(
  mode: DesktopServerExposureMode,
  options?: {
    readonly persist?: boolean;
    readonly rejectIfUnavailable?: boolean;
  },
): Effect.Effect<
  DesktopServerExposureState,
  unknown,
  FileSystem.FileSystem | EffectPath.Path | DesktopEnvironment | DesktopNetworkInterfacesService
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const networkInterfaces = yield* (yield* DesktopNetworkInterfacesService).read;
    const advertisedHostOverride = resolveAdvertisedHostOverride();
    const requestedMode = mode;
    let exposure = resolveDesktopServerExposure({
      mode,
      port: backendPort,
      networkInterfaces,
      ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
    });

    if (requestedMode === "network-accessible" && exposure.endpointUrl === null) {
      if (options?.rejectIfUnavailable) {
        return yield* Effect.fail(
          new Error("No reachable network address is available for this desktop right now."),
        );
      }
      exposure = resolveDesktopServerExposure({
        mode: "local-only",
        port: backendPort,
        networkInterfaces,
        ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
      });
    }

    desktopServerExposureMode = exposure.mode;
    desktopSettings = setDesktopServerExposurePreference(desktopSettings, requestedMode);
    backendBindHost = exposure.bindHost;
    backendHttpUrl = Option.some(new URL(exposure.localHttpUrl));
    backendEndpointUrl = exposure.endpointUrl;
    backendAdvertisedHost = exposure.advertisedHost;

    if (options?.persist) {
      yield* writeDesktopSettingsEffect(environment.desktopSettingsPath, desktopSettings);
    }

    return getDesktopServerExposureState();
  });
}

function applyDesktopTailscaleServeEnabled(
  nextSettings: DesktopSettings,
): Effect.Effect<
  DesktopServerExposureState,
  unknown,
  | FileSystem.FileSystem
  | EffectPath.Path
  | ElectronApp.ElectronApp
  | DesktopEnvironment
  | DesktopShutdown
  | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    desktopSettings = nextSettings;
    yield* writeDesktopSettingsEffect(environment.desktopSettingsPath, desktopSettings);
    yield* relaunchDesktopAppEffect(
      desktopSettings.tailscaleServeEnabled
        ? "tailscale-serve-enabled"
        : "tailscale-serve-disabled",
    );
    return getDesktopServerExposureState();
  });
}

function relaunchDesktopAppEffect(
  reason: string,
): Effect.Effect<
  void,
  never,
  ElectronApp.ElectronApp | DesktopEnvironment | DesktopShutdown | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<
      ElectronApp.ElectronApp | DesktopEnvironment | DesktopShutdown | DesktopState.DesktopState
    >();
    const runEffect = makeDesktopEffectRunner(context);
    yield* logDesktopInfo("desktop relaunch requested", { reason });
    yield* Effect.sync(() => {
      setImmediate(() => {
        void runEffect(
          Ref.set(state.quitting, true).pipe(Effect.andThen(requestDesktopShutdownAndWait())),
        ).finally(() => {
          if (environment.isDevelopment) {
            void runEffect(electronApp.exit(75));
            return;
          }
          void runEffect(
            electronApp
              .relaunch({
                execPath: process.execPath,
                args: process.argv.slice(1),
              })
              .pipe(Effect.andThen(electronApp.exit(0))),
          );
        });
      });
    });
  });
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function handleBackendReady(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): Effect.Effect<
  void,
  never,
  DesktopState.DesktopState | ElectronShell.ElectronShell | ElectronWindow.ElectronWindow
> {
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* Ref.set(state.backendReady, true);
    yield* logDesktopInfo("bootstrap backend ready", { source: "http" });

    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (!environment.isDevelopment && Option.isNone(existingWindow)) {
      const window = createWindow(runEffect, environment, electronWindow);
      yield* electronWindow.setMain(window);
      yield* logDesktopInfo("bootstrap main window created");
    }
  });
}

function createBackendWindowIfReady(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): Effect.Effect<
  void,
  never,
  DesktopState.DesktopState | ElectronShell.ElectronShell | ElectronWindow.ElectronWindow
> {
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const backendReady = yield* Ref.get(state.backendReady);
    if (!backendReady) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;
    const window = createWindow(runEffect, environment, electronWindow);
    yield* electronWindow.setMain(window);
  });
}

const resolveBackendStartConfig: Effect.Effect<
  DesktopBackendStartConfig,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  backendObservabilitySettings = yield* readPersistedBackendObservabilitySettings();
  const captureBackendLogs = !environment.isDevelopment;

  return {
    executablePath: process.execPath,
    entryPath: environment.backendEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...backendChildEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: backendPort,
      t3Home: environment.baseDir,
      host: backendBindHost,
      desktopBootstrapToken: backendBootstrapToken,
      tailscaleServeEnabled: desktopSettings.tailscaleServeEnabled,
      tailscaleServePort: desktopSettings.tailscaleServePort,
      ...(backendObservabilitySettings.otlpTracesUrl
        ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl }
        : {}),
      ...(backendObservabilitySettings.otlpMetricsUrl
        ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl }
        : {}),
    },
    httpBaseUrl: requireBackendHttpUrl(),
    captureOutput: captureBackendLogs,
  };
});

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const randomHexString = (length: number): Effect.Effect<string> =>
  Effect.gen(function* () {
    let value = "";
    while (value.length < length) {
      value += (yield* Random.nextUUIDv4).replace(/-/g, "");
    }
    return value.slice(0, length);
  });

const desktopEnvironmentLayer = Layer.effect(
  DesktopEnvironment,
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const metadata = yield* electronApp.metadata;
    return yield* makeDesktopEnvironment({
      dirname: __dirname,
      env: process.env,
      cwd: process.cwd(),
      platform: process.platform,
      processArch: process.arch,
      ...metadata,
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(EffectPath.layer, ElectronApp.layer)));

const desktopLoggerLayer = DesktopLoggerLive.pipe(Layer.provide(NodeServices.layer));

const desktopBackendOutputLogLayer = DesktopBackendOutputLogLive.pipe(
  Layer.provide(NodeServices.layer),
);

const desktopBackendConfigurationLayer = Layer.effect(
  DesktopBackendConfiguration,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    return {
      resolve: resolveBackendStartConfig.pipe(
        Effect.provideService(DesktopEnvironment, environment),
      ),
    };
  }),
);
const desktopSshEnvironmentBridgeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return DesktopSshEnvironmentBridge.layer({
      getMainWindow: electronWindow.main,
    });
  }),
);
const desktopBackendEventsLayer = Layer.effect(
  DesktopBackendEvents,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const backendOutputLog = yield* DesktopBackendOutputLog;
    const state = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<
      | DesktopEnvironment
      | DesktopSshEnvironmentBridge
      | DesktopState.DesktopState
      | ElectronShell.ElectronShell
      | ElectronWindow.ElectronWindow
    >();
    const runEffect = makeDesktopEffectRunner(context);

    return {
      onStarting: Ref.set(state.backendReady, false),
      onStarted: ({ pid, config }) =>
        backendOutputLog.writeSessionBoundary({
          phase: "START",
          runId: appRunId,
          details: `pid=${pid} port=${config.bootstrap.port} cwd=${config.cwd}`,
        }),
      onReady: handleBackendReady(runEffect, environment).pipe(Effect.provide(context)),
      onReadinessFailure: (error) =>
        logDesktopWarning("backend readiness check failed during bootstrap", {
          error: formatErrorMessage(error),
        }),
      onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
      onExit: ({ pid, reason }) =>
        Effect.gen(function* () {
          yield* Option.match(pid, {
            onNone: () => Effect.void,
            onSome: (value) =>
              backendOutputLog.writeSessionBoundary({
                phase: "END",
                runId: appRunId,
                details: `pid=${value} ${reason}`,
              }),
          });
          yield* Ref.set(state.backendReady, false);
        }),
      onRestartScheduled: ({ reason, delay }) =>
        logDesktopError("backend exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        }),
    };
  }),
);

function resolveDesktopSshCliRunner(environment: DesktopEnvironmentShape): RemoteT3RunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: devRemoteEntryPath };
  }
  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: environment.appVersion,
      updateChannel: desktopSettings.updateChannel,
      isDevelopment: environment.isDevelopment,
    }),
  };
}

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    return DesktopSshEnvironmentManager.layer({
      resolveCliRunner: () => resolveDesktopSshCliRunner(environment),
    });
  }),
);

const desktopShellEnvironmentProbeLayer = DesktopShellEnvironmentProbeLive.pipe(
  Layer.provide(NodeServices.layer),
);

const desktopShellEnvironmentLayer = DesktopShellEnvironmentLive.pipe(
  Layer.provide(
    Layer.mergeAll(DesktopShellEnvironmentConfigLive, desktopShellEnvironmentProbeLayer),
  ),
);

type DesktopServerExposureIpcActionServices =
  | FileSystem.FileSystem
  | EffectPath.Path
  | ElectronApp.ElectronApp
  | DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopNetworkInterfacesService
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

const desktopServerExposureIpcActionsLayer = Layer.effect(
  DesktopServerExposureIpcActions,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopServerExposureIpcActionServices>();
    return DesktopServerExposureIpcActions.of({
      getState: Effect.sync(getDesktopServerExposureState),
      setMode: (nextMode) =>
        Effect.gen(function* () {
          if (nextMode === desktopServerExposureMode) {
            return getDesktopServerExposureState();
          }

          const nextState = yield* applyDesktopServerExposureMode(nextMode, {
            persist: true,
            rejectIfUnavailable: true,
          });
          yield* relaunchDesktopAppEffect(`serverExposureMode=${nextMode}`);
          return nextState;
        }).pipe(Effect.provide(context)),
      setTailscaleServeEnabled: (input) =>
        Effect.gen(function* () {
          const nextSettings = setDesktopTailscaleServePreference(desktopSettings, {
            enabled: input.enabled,
            ...(typeof input.port === "number" ? { port: input.port } : {}),
          });
          if (nextSettings === desktopSettings) {
            return getDesktopServerExposureState();
          }
          return yield* applyDesktopTailscaleServeEnabled(nextSettings);
        }).pipe(Effect.provide(context)),
      getAdvertisedEndpoints: getDesktopAdvertisedEndpoints().pipe(Effect.provide(context)),
    });
  }),
);

type DesktopUpdateIpcActionServices =
  | FileSystem.FileSystem
  | EffectPath.Path
  | DesktopEnvironment
  | DesktopBackendManager
  | DesktopState.DesktopState;

const desktopUpdateIpcActionsLayer = Layer.effect(
  DesktopUpdateIpcActions,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopUpdateIpcActionServices>();
    const state = yield* DesktopState.DesktopState;
    return DesktopUpdateIpcActions.of({
      getState: Effect.sync(() => updateState),
      setChannel: (nextChannel) =>
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment;
          if (updateCheckInFlight || updateDownloadInFlight || updateInstallInFlight) {
            return yield* Effect.fail(
              new Error("Cannot change update tracks while an update action is in progress."),
            );
          }

          desktopSettings = setDesktopUpdateChannelPreference(desktopSettings, nextChannel);
          yield* writeDesktopSettingsEffect(environment.desktopSettingsPath, desktopSettings);

          if (nextChannel === updateState.channel) {
            return updateState;
          }

          const enabled = shouldEnableAutoUpdates(environment);
          setUpdateState(createBaseUpdateState(nextChannel, enabled, environment));

          if (!enabled || !updaterConfigured) {
            return updateState;
          }

          yield* applyAutoUpdaterChannel(nextChannel);
          const allowDowngrade = autoUpdater.allowDowngrade;
          autoUpdater.allowDowngrade = true;
          yield* checkForUpdates("channel-change").pipe(
            Effect.ensuring(
              Effect.sync(() => {
                autoUpdater.allowDowngrade = allowDowngrade;
              }),
            ),
          );
          return updateState;
        }).pipe(Effect.provide(context)),
      download: Effect.gen(function* () {
        const result = yield* downloadAvailableUpdate();
        return {
          accepted: result.accepted,
          completed: result.completed,
          state: updateState,
        };
      }).pipe(Effect.provide(context)),
      install: Effect.gen(function* () {
        if (yield* Ref.get(state.quitting)) {
          return {
            accepted: false,
            completed: false,
            state: updateState,
          };
        }
        const result = yield* installDownloadedUpdate();
        return {
          accepted: result.accepted,
          completed: result.completed,
          state: updateState,
        };
      }).pipe(Effect.provide(context)),
      check: Effect.gen(function* () {
        if (!updaterConfigured) {
          return {
            checked: false,
            state: updateState,
          };
        }
        const checked = yield* checkForUpdates("web-ui");
        return {
          checked,
          state: updateState,
        };
      }).pipe(Effect.provide(context)),
    });
  }),
);

const desktopBackendDependenciesLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  NetService.layer,
  DesktopBackendProcessRunnerLive,
  desktopBackendConfigurationLayer,
  desktopBackendEventsLayer.pipe(Layer.provide(desktopBackendOutputLogLayer)),
);

const desktopBackendManagerLayer = DesktopBackendManagerLive.pipe(
  Layer.provide(desktopBackendDependenciesLayer),
);

const desktopBackendRuntimeLayer = DesktopLocalEnvironment.layer.pipe(
  Layer.provideMerge(desktopBackendManagerLayer),
);

const desktopElectronWindowLayer = desktopSshEnvironmentBridgeLayer.pipe(
  Layer.provideMerge(ElectronWindow.layer),
);

const desktopRuntimeLayer = Layer.mergeAll(
  desktopLoggerLayer,
  NetService.layer,
  desktopShellEnvironmentLayer,
  desktopSshEnvironmentLayer,
  Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(ipcMain)),
  desktopServerExposureIpcActionsLayer,
  desktopUpdateIpcActionsLayer,
  DesktopWindowIpcActionsLive.layer,
  DesktopSecretStorage.layer,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(DesktopNetworkInterfacesLive),
  Layer.provideMerge(desktopBackendRuntimeLayer),
  Layer.provideMerge(desktopElectronWindowLayer),
  Layer.provideMerge(ElectronApp.layer),
  Layer.provideMerge(ElectronDialog.layer),
  Layer.provideMerge(ElectronMenu.layer),
  Layer.provideMerge(ElectronProtocol.layer),
  Layer.provideMerge(ElectronShell.layer),
  Layer.provideMerge(ElectronTheme.layer),
  Layer.provideMerge(desktopEnvironmentLayer),
);

let updatePollerScope: Option.Option<Scope.Closeable> = Option.none();
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updateInstallInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = createInitialDesktopUpdateState(
  "0.0.0",
  {
    hostArch: "other",
    appArch: "other",
    runningUnderArm64Translation: false,
  },
  DEFAULT_DESKTOP_SETTINGS.updateChannel,
);

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

function parseAppUpdateYml(raw: string): Option.Option<Record<string, string>> {
  // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
  // doing a line-based parse (fields: provider, owner, repo, releaseType, ...).
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
  }
  return entries.provider ? Option.some(entries) : Option.none();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYmlEffect(): Effect.Effect<
  Option.Option<Record<string, string>>,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const raw = yield* fileSystem
      .readFileString(environment.appUpdateYmlPath, "utf-8")
      .pipe(Effect.option);
    return Option.match(raw, {
      onNone: () => Option.none<Record<string, string>>(),
      onSome: parseAppUpdateYml,
    });
  });
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHashEffect(): Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
    const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
    return yield* Option.match(raw, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (value) =>
        Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata))(value).pipe(
          Effect.map((parsed) =>
            Option.fromNullishOr(normalizeCommitHash(parsed.t3codeCommitHash)),
          ),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        ),
    });
  });
}

function resolveAboutCommitHash(): Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  if (aboutCommitHashCache !== undefined) {
    return Effect.succeed(aboutCommitHashCache);
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = Option.some(envCommitHash);
    return Effect.succeed(aboutCommitHashCache);
  }

  // Only packaged builds are required to expose commit metadata.
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (!environment.isPackaged) {
      aboutCommitHashCache = Option.none();
      return aboutCommitHashCache;
    }

    return yield* resolveEmbeddedCommitHashEffect().pipe(
      Effect.tap((commitHash) =>
        Effect.sync(() => {
          aboutCommitHashCache = commitHash;
        }),
      ),
    );
  });
}

function handleFatalStartupError(
  stage: string,
  error: unknown,
): Effect.Effect<
  void,
  never,
  | DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  return Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown;
    const state = yield* DesktopState.DesktopState;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const message = formatErrorMessage(error);
    const detail =
      error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    yield* logDesktopError("fatal startup error", {
      stage,
      message,
      ...(detail.length > 0 ? { detail } : {}),
    });
    const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
    if (!wasQuitting) {
      yield* electronDialog.showErrorBox(
        "T3 Code failed to start",
        `Stage: ${stage}\n${message}${detail}`,
      );
    }
    yield* shutdown.request;
    yield* electronApp.quit;
  });
}

function registerDesktopProtocol(): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | DesktopEnvironment | ElectronProtocol.ElectronProtocol | Scope.Scope
> {
  return Effect.gen(function* () {
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    yield* electronProtocol.registerDesktopFileProtocol;
  });
}

function dispatchMenuAction(
  action: string,
  environment: DesktopEnvironmentShape,
): Effect.Effect<void, never, DesktopWindowBoundaryServices> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<DesktopWindowBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const existingWindow = yield* electronWindow.focusedMainOrFirst;
    const targetWindow =
      Option.getOrUndefined(existingWindow) ?? createWindow(runEffect, environment, electronWindow);
    if (Option.isNone(existingWindow)) {
      yield* electronWindow.setMain(targetWindow);
    }

    const send = () => {
      if (targetWindow.isDestroyed()) return;
      targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
      void runEffect(electronWindow.reveal(targetWindow));
    };

    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", send);
      return;
    }

    send();
  });
}

function handleCheckForUpdatesMenuClick(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment: environment.isDevelopment,
    isPackaged: environment.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasDesktopUpdateFeedConfig(),
  });
  if (disabledReason) {
    void runEffect(
      logUpdaterInfo("manual update check requested, but updates are disabled", {
        disabledReason,
      }),
    );
    void runEffect(
      Effect.gen(function* () {
        const electronDialog = yield* ElectronDialog.ElectronDialog;
        yield* electronDialog.showMessageBox({
          type: "info",
          title: "Updates unavailable",
          message: "Automatic updates are not available right now.",
          detail: disabledReason,
          buttons: ["OK"],
        });
      }),
    );
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    void runEffect(
      Effect.gen(function* () {
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        yield* electronWindow.setMain(createWindow(runEffect, environment, electronWindow));
        yield* checkForUpdatesFromMenu();
      }),
    );
    return;
  }
  void runEffect(checkForUpdatesFromMenu());
}

function hasDesktopUpdateFeedConfig(): boolean {
  return Option.isSome(appUpdateYmlConfig) || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
}

function checkForUpdatesFromMenu(): Effect.Effect<
  void,
  never,
  DesktopState.DesktopState | ElectronDialog.ElectronDialog
> {
  return Effect.gen(function* () {
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    yield* checkForUpdates("menu");

    if (updateState.status === "up-to-date") {
      yield* electronDialog.showMessageBox({
        type: "info",
        title: "You're up to date!",
        message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
        buttons: ["OK"],
      });
    } else if (updateState.status === "error") {
      yield* electronDialog.showMessageBox({
        type: "warning",
        title: "Update check failed",
        message: "Could not check for updates.",
        detail: updateState.message ?? "An unknown error occurred. Please try again later.",
        buttons: ["OK"],
      });
    }
  });
}

function configureApplicationMenu(): Effect.Effect<
  void,
  never,
  ElectronApp.ElectronApp | DesktopWindowBoundaryServices
> {
  return Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment;
    const appName = yield* electronApp.name;
    const context = yield* Effect.context<
      ElectronApp.ElectronApp | DesktopWindowBoundaryServices
    >();
    const runEffect = makeDesktopEffectRunner(context);
    const template: MenuItemConstructorOptions[] = [];

    if (process.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates...",
            click: () => handleCheckForUpdatesMenuClick(runEffect, environment),
          },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              void runEffect(dispatchMenuAction("open-settings", environment));
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(process.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: () => {
                    void runEffect(dispatchMenuAction("open-settings", environment));
                  },
                },
                { type: "separator" as const },
              ]),
          { role: process.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Check for Updates...",
            click: () => handleCheckForUpdatesMenuClick(runEffect, environment),
          },
        ],
      },
    );

    yield* Effect.sync(() => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    });
  });
}

function resolveResourcePath(
  fileName: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | DesktopEnvironment> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const candidates = environment.resolveResourcePathCandidates(fileName);
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });
}

function resolveIconPath(
  ext: "ico" | "icns" | "png",
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | DesktopEnvironment> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    if (environment.isDevelopment && process.platform === "darwin" && ext === "png") {
      const developmentDockIconPath = environment.developmentDockIconPath;
      const developmentDockIconExists = yield* fileSystem
        .exists(developmentDockIconPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (developmentDockIconExists) {
        return Option.some(developmentDockIconPath);
      }
    }

    return yield* resolveResourcePath(`icon.${ext}`);
  });
}

function resolveDesktopIconPaths(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const [ico, icns, png] = yield* Effect.all(
      [resolveIconPath("ico"), resolveIconPath("icns"), resolveIconPath("png")] as const,
      { concurrency: "unbounded" },
    );
    desktopIconPaths = { ico, icns, png };
  });
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which currently produces directories with spaces and
 * parentheses (e.g. `~/.config/T3 Code (Alpha)` on Linux). This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`t3code`). If the legacy
 * directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
function resolveUserDataPath(): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const appDataBase =
      process.platform === "win32"
        ? process.env.APPDATA ||
          environment.path.join(environment.homeDirectory, "AppData", "Roaming")
        : process.platform === "darwin"
          ? environment.path.join(environment.homeDirectory, "Library", "Application Support")
          : process.env.XDG_CONFIG_HOME ||
            environment.path.join(environment.homeDirectory, ".config");
    const legacyPath = environment.path.join(appDataBase, environment.legacyUserDataDirName);
    const legacyPathExists = yield* fileSystem
      .exists(legacyPath)
      .pipe(Effect.orElseSucceed(() => false));
    return legacyPathExists
      ? legacyPath
      : environment.path.join(appDataBase, environment.userDataDirName);
  });
}

function configureAppIdentity(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | ElectronApp.ElectronApp | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment;
    const commitHash = yield* resolveAboutCommitHash();
    yield* electronApp.setName(environment.displayName);
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (process.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }

    if (process.platform === "linux") {
      yield* electronApp.setDesktopName(environment.linuxDesktopEntryName);
    }

    if (process.platform === "darwin") {
      yield* Option.match(desktopIconPaths.png, {
        onNone: () => Effect.void,
        onSome: electronApp.setDockIcon,
      });
    }
  });
}

function clearUpdatePollTimer(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const scope = updatePollerScope;
    updatePollerScope = Option.none();
    yield* Option.match(scope, {
      onNone: () => Effect.void,
      onSome: (value) => Scope.close(value, Exit.void).pipe(Effect.ignore),
    });
  });
}

function startUpdatePollers(): Effect.Effect<void, never, Scope.Scope | DesktopState.DesktopState> {
  return Effect.gen(function* () {
    yield* clearUpdatePollTimer();
    const parentScope = yield* Scope.Scope;
    const scope = yield* Scope.make("sequential");
    updatePollerScope = Option.some(scope);
    yield* Scope.addFinalizer(parentScope, Scope.close(scope, Exit.void).pipe(Effect.ignore));

    yield* Effect.sleep(Duration.millis(AUTO_UPDATE_STARTUP_DELAY_MS)).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) =>
        logUpdaterError("startup update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkIn(scope),
    );
    yield* Effect.sleep(Duration.millis(AUTO_UPDATE_POLL_INTERVAL_MS)).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) =>
        logUpdaterError("poll update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkIn(scope),
    );
  });
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironmentShape,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function applyAutoUpdaterChannel(channel: DesktopUpdateChannel): Effect.Effect<void> {
  return Effect.gen(function* () {
    const allowsPrerelease = channel === "nightly";
    yield* Effect.sync(() => {
      autoUpdater.channel = channel;
      autoUpdater.allowPrerelease = allowsPrerelease;
      autoUpdater.allowDowngrade = allowsPrerelease;
    });
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
    });
  });
}

function shouldEnableAutoUpdates(environment: DesktopEnvironmentShape): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment: environment.isDevelopment,
      isPackaged: environment.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
      hasUpdateFeedConfig: hasDesktopUpdateFeedConfig(),
    }) === null
  );
}

function checkForUpdates(reason: string): Effect.Effect<boolean, never, DesktopState.DesktopState> {
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    if ((yield* Ref.get(state.quitting)) || !updaterConfigured || updateCheckInFlight) return false;
    if (updateState.status === "downloading" || updateState.status === "downloaded") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: updateState.status,
      });
      return false;
    }

    updateCheckInFlight = true;
    const checkedAt = yield* currentIsoTimestamp;
    setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, checkedAt));
    yield* logUpdaterInfo("checking for updates", { reason });

    return yield* Effect.promise(() => autoUpdater.checkForUpdates()).pipe(
      Effect.as(true),
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const failedAt = yield* currentIsoTimestamp;
          const message = formatErrorMessage(error);
          setUpdateState(reduceDesktopUpdateStateOnCheckFailure(updateState, message, failedAt));
          yield* logUpdaterError("failed to check for updates", { message });
          return true;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          updateCheckInFlight = false;
        }),
      ),
    );
  });
}

function downloadAvailableUpdate(): Effect.Effect<
  {
    accepted: boolean;
    completed: boolean;
  },
  never,
  DesktopEnvironment
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
      return { accepted: false, completed: false };
    }

    updateDownloadInFlight = true;
    setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
    autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(environment.runtimeInfo);
    yield* logUpdaterInfo("downloading update");

    return yield* Effect.promise(() => autoUpdater.downloadUpdate()).pipe(
      Effect.as({ accepted: true, completed: true }),
      Effect.catch((error: unknown) =>
        Effect.sync(() => {
          const message = formatErrorMessage(error);
          setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
          return { accepted: true, completed: false };
        }).pipe(
          Effect.tap(() =>
            logUpdaterError("failed to download update", { message: formatErrorMessage(error) }),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          updateDownloadInFlight = false;
        }),
      ),
    );
  });
}

function installDownloadedUpdate(): Effect.Effect<
  {
    accepted: boolean;
    completed: boolean;
  },
  never,
  DesktopBackendManager | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    if (
      (yield* Ref.get(state.quitting)) ||
      !updaterConfigured ||
      updateState.status !== "downloaded"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(state.quitting, true);
    updateInstallInFlight = true;
    yield* clearUpdatePollTimer();

    return yield* Effect.gen(function* () {
      const backendManager = yield* DesktopBackendManager;
      yield* backendManager.stop({ timeout: Duration.seconds(5) });
      yield* Effect.sync(() => {
        // Destroy all windows before launching the NSIS installer to avoid the installer finding live windows it needs to close.
        for (const win of BrowserWindow.getAllWindows()) {
          win.destroy();
        }
        // `quitAndInstall()` only starts the handoff to the updater. The actual
        // install may still fail asynchronously, so keep the action incomplete
        // until we either quit or receive an updater error.
        autoUpdater.quitAndInstall(true, true);
      });
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const message = formatErrorMessage(error);
          yield* Effect.sync(() => {
            updateInstallInFlight = false;
            setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
          });
          yield* Ref.set(state.quitting, false);
          yield* logUpdaterError("failed to install update", { message });
          return { accepted: true, completed: false };
        }),
      ),
    );
  });
}

function configureAutoUpdater(): Effect.Effect<
  void,
  never,
  Scope.Scope | DesktopEnvironment | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<DesktopEnvironment>();
    const runEffect = makeDesktopEffectRunner(context);
    const githubToken =
      process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
    if (githubToken) {
      // When a token is provided, re-configure the feed with `private: true` so
      // electron-updater uses the GitHub API (api.github.com) instead of the
      // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
      const appUpdateYml = Option.getOrUndefined(appUpdateYmlConfig);
      if (appUpdateYml?.provider === "github") {
        autoUpdater.setFeedURL({
          ...appUpdateYml,
          provider: "github" as const,
          private: true,
          token: githubToken,
        });
      }
    }

    if (process.env.T3CODE_DESKTOP_MOCK_UPDATES) {
      autoUpdater.setFeedURL({
        provider: "generic",
        url: `http://localhost:${process.env.T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
      });
    }

    const enabled = shouldEnableAutoUpdates(environment);
    setUpdateState(createBaseUpdateState(desktopSettings.updateChannel, enabled, environment));
    if (!enabled) {
      return;
    }
    updaterConfigured = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    yield* applyAutoUpdaterChannel(desktopSettings.updateChannel);
    autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(environment.runtimeInfo);
    let lastLoggedDownloadMilestone = -1;

    if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
      yield* logUpdaterInfo(
        "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
      );
    }

    yield* addScopedListener(autoUpdater, "checking-for-update", () => {
      void runEffect(logUpdaterInfo("looking for updates"));
    });
    yield* addScopedListener(autoUpdater, "update-available", (info: { version: string }) => {
      if (!doesVersionMatchDesktopUpdateChannel(info.version, updateState.channel)) {
        void runEffect(
          logUpdaterInfo("ignoring update that does not match selected channel", {
            version: info.version,
            channel: updateState.channel,
          }),
        );
        setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, nowIsoTimestamp()));
        lastLoggedDownloadMilestone = -1;
        return;
      }

      setUpdateState(
        reduceDesktopUpdateStateOnUpdateAvailable(updateState, info.version, nowIsoTimestamp()),
      );
      lastLoggedDownloadMilestone = -1;
      void runEffect(logUpdaterInfo("update available", { version: info.version }));
    });
    yield* addScopedListener(autoUpdater, "update-not-available", () => {
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, nowIsoTimestamp()));
      lastLoggedDownloadMilestone = -1;
      void runEffect(logUpdaterInfo("no updates available"));
    });
    yield* addScopedListener(autoUpdater, "error", (error: unknown) => {
      const message = formatErrorMessage(error);
      if (updateInstallInFlight) {
        updateInstallInFlight = false;
        void runEffect(Ref.set(state.quitting, false));
        setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
        void runEffect(logUpdaterError("updater error", { message }));
        return;
      }
      if (!updateCheckInFlight && !updateDownloadInFlight) {
        setUpdateState({
          status: "error",
          message,
          checkedAt: nowIsoTimestamp(),
          downloadPercent: null,
          errorContext: resolveUpdaterErrorContext(),
          canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
        });
      }
      void runEffect(logUpdaterError("updater error", { message }));
    });
    yield* addScopedListener(autoUpdater, "download-progress", (progress: { percent: number }) => {
      const percent = Math.floor(progress.percent);
      if (
        shouldBroadcastDownloadProgress(updateState, progress.percent) ||
        updateState.message !== null
      ) {
        setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
      }
      const milestone = percent - (percent % 10);
      if (milestone > lastLoggedDownloadMilestone) {
        lastLoggedDownloadMilestone = milestone;
        void runEffect(logUpdaterInfo("download progress", { percent }));
      }
    });
    yield* addScopedListener(autoUpdater, "update-downloaded", (info: { version: string }) => {
      setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
      void runEffect(logUpdaterInfo("update downloaded", { version: info.version }));
    });

    yield* startUpdatePollers();
  });
}

function startBackend(): Effect.Effect<
  void,
  never,
  DesktopBackendManager | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const state = yield* DesktopState.DesktopState;
    if (yield* Ref.get(state.quitting)) return;
    const backendManager = yield* DesktopBackendManager;
    yield* backendManager.start;
  }).pipe(
    Effect.catchCause((cause) =>
      logDesktopError("failed to start backend", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
}

function closeDesktopResourcesWithManager(
  backendManager: DesktopBackendManagerShape,
  desktopSshEnvironmentBridge: DesktopSshEnvironmentBridgeShape,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* backendManager.shutdown;
    updateInstallInFlight = false;
    yield* clearUpdatePollTimer();
    yield* desktopSshEnvironmentBridge.disposeEffect().pipe(Effect.ignore);
  });
}

function requestDesktopShutdownAndWait(): Effect.Effect<void, never, DesktopShutdown> {
  return Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  });
}

function quitFromSignal(signal: "SIGINT" | "SIGTERM", runEffect: DesktopEffectRunner): void {
  void runEffect(
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logDesktopInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      yield* electronApp.quit;
    }),
  );
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = Option.getOrUndefined(desktopIconPaths[ext]);
  return iconPath ? { icon: iconPath } : {};
}

function getInitialWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

function getWindowTitleBarOptions(): WindowTitleBarOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: nativeTheme.shouldUseDarkColors
        ? TITLEBAR_DARK_SYMBOL_COLOR
        : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.setBackgroundColor(getInitialWindowBackgroundColor());
  const { titleBarOverlay } = getWindowTitleBarOptions();
  if (typeof titleBarOverlay === "object") {
    window.setTitleBarOverlay(titleBarOverlay);
  }
}

function createWindow(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
  electronWindow: ElectronWindow.ElectronWindowShape,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: getInitialWindowBackgroundColor(),
    ...getIconOption(),
    title: environment.displayName,
    ...getWindowTitleBarOptions(),
    webPreferences: {
      preload: environment.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
      menuTemplate.push(
        {
          label: "Copy Link",
          click: () => {
            void runEffect(
              Effect.gen(function* () {
                const electronShell = yield* ElectronShell.ElectronShell;
                yield* electronShell.copyText(params.linkURL);
              }),
            );
          },
        },
        { type: "separator" },
      );
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
      void runEffect(
        Effect.gen(function* () {
          const electronShell = yield* ElectronShell.ElectronShell;
          yield* electronShell.openExternal(url);
        }),
      );
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(environment.displayName);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(environment.displayName);
    emitUpdateState();
  });

  // On Linux/Wayland with `show: false`, Electron's `ready-to-show` only
  // fires after `show()` is called, deadlocking the standard "wait for
  // ready, then show" pattern. Add `did-finish-load` as a Linux-only
  // fallback so the window still surfaces once the renderer has loaded
  // the page. Other platforms keep the no-flash `ready-to-show` path,
  // since `did-finish-load` typically fires before the first paint there.
  const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
  if (process.platform === "linux") {
    revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
  }
  bindFirstRevealTrigger(revealSubscribers, () => {
    void runEffect(electronWindow.reveal(window));
  });

  if (environment.isDevelopment) {
    void window.loadURL(resolveDesktopDevServerUrl(environment));
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(requireBackendHttpUrl().href);
  }

  window.on("closed", () => {
    void runEffect(
      Effect.gen(function* () {
        const desktopSshEnvironmentBridge = yield* DesktopSshEnvironmentBridge;
        yield* desktopSshEnvironmentBridge.cancelPendingPasswordPromptsEffect(
          "SSH authentication was cancelled because the app window closed.",
        );
      }),
    );
    void runEffect(electronWindow.clearMain(window));
  });

  return window;
}

function bootstrap() {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<DesktopWindowBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    yield* logDesktopInfo("bootstrap start");
    const configuredBackendPort = resolveConfiguredDesktopBackendPort(process.env.T3CODE_PORT);
    if (environment.isDevelopment && configuredBackendPort === undefined) {
      return yield* Effect.fail(new Error("T3CODE_PORT is required in desktop development."));
    }

    backendPort =
      configuredBackendPort ??
      (yield* resolveDesktopBackendPortEffect({
        host: DESKTOP_LOOPBACK_HOST,
        startPort: DEFAULT_DESKTOP_BACKEND_PORT,
        requiredHosts: DESKTOP_REQUIRED_PORT_PROBE_HOSTS,
      }));
    yield* logDesktopInfo(
      configuredBackendPort === undefined
        ? "selected backend port via sequential scan"
        : "using configured backend port",
      {
        port: backendPort,
        ...(configuredBackendPort === undefined ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
      },
    );
    backendBootstrapToken = yield* randomHexString(48);
    if (desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode) {
      yield* logDesktopInfo("bootstrap restoring persisted server exposure mode", {
        mode: desktopSettings.serverExposureMode,
      });
    }
    const serverExposureState = yield* applyDesktopServerExposureMode(
      desktopSettings.serverExposureMode,
      {
        persist: desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
      },
    );
    yield* logDesktopInfo("bootstrap resolved backend endpoint", {
      baseUrl: getBackendHttpUrlHref(),
    });
    if (serverExposureState.endpointUrl) {
      yield* logDesktopInfo("bootstrap enabled network access", {
        endpointUrl: serverExposureState.endpointUrl,
      });
    } else if (desktopSettings.serverExposureMode === "network-accessible") {
      yield* logDesktopWarning(
        "bootstrap fell back to local-only because no advertised network host was available",
      );
    }

    yield* installDesktopIpcHandlers;
    yield* logDesktopInfo("bootstrap ipc handlers registered");
    yield* startBackend();
    yield* logDesktopInfo("bootstrap backend start requested");

    if (environment.isDevelopment) {
      yield* electronWindow.setMain(createWindow(runEffect, environment, electronWindow));
      yield* logDesktopInfo("bootstrap main window created");
    }
  });
}

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: DesktopEffectRunner,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logDesktopInfo("before-quit received");
      }),
    );
    return;
  }

  event.preventDefault();
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(state.quitting, true);
      yield* logDesktopInfo("before-quit received");
      yield* requestDesktopShutdownAndWait();
    }),
  ).finally(() => {
    markQuitAllowed();
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.quit;
      }),
    );
  });
}

function handleActivate(
  environment: DesktopEnvironmentShape,
): Effect.Effect<void, never, DesktopWindowBoundaryServices> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<DesktopWindowBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) {
      yield* electronWindow.reveal(existingWindow.value);
      return;
    }
    if (environment.isDevelopment) {
      const window = createWindow(runEffect, environment, electronWindow);
      yield* electronWindow.setMain(window);
      return;
    }
    yield* createBackendWindowIfReady(runEffect, environment);
  });
}

function handleWindowAllClosed(): Effect.Effect<
  void,
  never,
  ElectronApp.ElectronApp | DesktopState.DesktopState
> {
  return Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const state = yield* DesktopState.DesktopState;
    if (process.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
      yield* electronApp.quit;
    }
  });
}

function registerDesktopLifecycleHandlers(): Effect.Effect<
  void,
  never,
  Scope.Scope | DesktopLifecycleBoundaryServices
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const context = yield* Effect.context<DesktopLifecycleBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    let quitAllowed = false;
    yield* addScopedListener(nativeTheme, "updated", () => {
      void runEffect(electronWindow.syncAllAppearance(syncWindowAppearance));
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on("activate", () => {
      void runEffect(handleActivate(environment));
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(handleWindowAllClosed());
    });

    if (process.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  });
}

function fatalStartupCause(stage: string, cause: Cause.Cause<unknown>) {
  return handleFatalStartupError(stage, new Error(Cause.pretty(cause))).pipe(
    Effect.andThen(Effect.failCause(cause)),
  );
}

const waitForElectronReady = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.whenReady;
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const shutdown = yield* makeDesktopShutdown;

    yield* Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
      yield* electronProtocol.registerDesktopSchemePrivileges;

      const environment = yield* DesktopEnvironment;
      appRunId = (yield* Random.nextUUIDv4).replace(/-/g, "").slice(0, 12);
      const backendManager = yield* DesktopBackendManager;
      const shellEnvironment = yield* DesktopShellEnvironment;
      const desktopSshEnvironmentBridge = yield* DesktopSshEnvironmentBridge;
      const sshPasswordPromptScope = yield* Scope.make("sequential");
      yield* desktopSshEnvironmentBridge.installPasswordPromptScope(sshPasswordPromptScope);
      yield* Scope.addFinalizer(
        yield* Scope.Scope,
        closeDesktopResourcesWithManager(backendManager, desktopSshEnvironmentBridge).pipe(
          Effect.ensuring(shutdown.markComplete),
        ),
      );

      yield* shellEnvironment.sync;
      const userDataPath = yield* resolveUserDataPath();
      // Must happen before Electron's ready event so Chromium profile data
      // lands in the desktop-specific userData directory.
      yield* electronApp.setPath("userData", userDataPath);
      appUpdateYmlConfig = yield* readAppUpdateYmlEffect();
      yield* resolveDesktopIconPaths();
      yield* logDesktopInfo("runtime logging configured", { logDir: environment.logDir });
      desktopSettings = yield* readDesktopSettingsEffect(
        environment.desktopSettingsPath,
        environment.appVersion,
      );
      desktopServerExposureMode = desktopSettings.serverExposureMode;
      updateState = initialUpdateState(environment);

      if (process.platform === "linux") {
        yield* electronApp.appendCommandLineSwitch("class", environment.linuxWmClass);
      }

      yield* configureAppIdentity();
      yield* registerDesktopLifecycleHandlers();

      yield* waitForElectronReady.pipe(
        Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
      );
      yield* logDesktopInfo("app ready");
      yield* configureAppIdentity();
      yield* configureApplicationMenu();
      yield* registerDesktopProtocol();
      yield* configureAutoUpdater();
      yield* bootstrap().pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
      yield* shutdown.awaitRequest;
    }).pipe(Effect.provideService(DesktopShutdown, shutdown));
  }),
).pipe(
  Effect.catchCause((cause) =>
    logDesktopError("desktop main fiber failed", {
      cause: Cause.pretty(cause),
    }),
  ),
);

program.pipe(
  Effect.provide(desktopRuntimeLayer),
  Effect.provide(DesktopState.layer),
  NodeRuntime.runMain,
);
