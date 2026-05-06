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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";

import type {
  ContextMenuItem,
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
import { showDesktopConfirmDialog } from "./confirmDialog.ts";
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
import { DesktopSecretStorage } from "./electron/DesktopSecretStorage.ts";
import { DesktopShutdown, makeDesktopShutdown } from "./desktopShutdown.ts";
import { MENU_ACTION_CHANNEL, UPDATE_STATE_CHANNEL } from "./ipc/channels.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import { installDesktopIpcHandlers } from "./ipc/DesktopIpcHandlers.ts";
import { DesktopServerExposureIpcActions } from "./ipc/methods/serverExposure.ts";
import { DesktopUpdateIpcActions } from "./ipc/methods/updates.ts";
import { DesktopWindowIpcActions } from "./ipc/methods/window.ts";
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

const DESKTOP_SCHEME = "t3";
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

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

type WindowTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};
interface BackendObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}
let mainWindow: BrowserWindow | null = null;
let backendReady = false;
let backendPort = 0;
let backendBindHost = DESKTOP_LOOPBACK_HOST;
let backendBootstrapToken = "";
let backendHttpUrl: Option.Option<URL> = Option.none();
let backendWsUrl = "";
let backendEndpointUrl: string | null = null;
let backendAdvertisedHost: string | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
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

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;

interface DesktopEffectRunner {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A>;
}

type DesktopWindowBoundaryServices = DesktopEnvironment | DesktopSshEnvironmentBridge;
type DesktopLifecycleBoundaryServices = DesktopShutdown | DesktopWindowBoundaryServices;

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
    backendWsUrl = exposure.localWsUrl;
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
  FileSystem.FileSystem | EffectPath.Path | DesktopEnvironment | DesktopShutdown
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
): Effect.Effect<void, never, DesktopEnvironment | DesktopShutdown> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const context = yield* Effect.context<DesktopEnvironment | DesktopShutdown>();
    const runEffect = makeDesktopEffectRunner(context);
    yield* logDesktopInfo("desktop relaunch requested", { reason });
    yield* Effect.sync(() => {
      setImmediate(() => {
        isQuitting = true;
        void runEffect(requestDesktopShutdownAndWait()).finally(() => {
          if (environment.isDevelopment) {
            app.exit(75);
            return;
          }
          app.relaunch({
            execPath: process.execPath,
            args: process.argv.slice(1),
          });
          app.exit(0);
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

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function handleBackendReady(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      backendReady = true;
    });
    yield* logDesktopInfo("bootstrap backend ready", { source: "http" });

    const createdWindow = yield* Effect.sync(() => {
      const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
      if (environment.isDevelopment || existingWindow !== null) {
        return false;
      }

      mainWindow = createWindow(runEffect, environment);
      return true;
    });
    if (createdWindow) {
      yield* logDesktopInfo("bootstrap main window created");
    }
  });
}

function createBackendWindowIfReady(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): void {
  if (!backendReady) return;
  const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (existingWindow !== null) return;
  mainWindow = createWindow(runEffect, environment);
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
  makeDesktopEnvironment({
    dirname: __dirname,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    processArch: process.arch,
    appVersion: app.getVersion(),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    runningUnderArm64Translation: app.runningUnderARM64Translation === true,
  }),
).pipe(Layer.provide(EffectPath.layer));

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
const desktopSshEnvironmentBridgeLayer = DesktopSshEnvironmentBridge.layer({
  getMainWindow: () => mainWindow,
});
const desktopBackendEventsLayer = Layer.effect(
  DesktopBackendEvents,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const backendOutputLog = yield* DesktopBackendOutputLog;
    const context = yield* Effect.context<DesktopEnvironment | DesktopSshEnvironmentBridge>();
    const runEffect = makeDesktopEffectRunner(context);

    return {
      onStarting: Effect.sync(() => {
        backendReady = false;
      }),
      onStarted: ({ pid, config }) =>
        backendOutputLog.writeSessionBoundary({
          phase: "START",
          runId: appRunId,
          details: `pid=${pid} port=${config.bootstrap.port} cwd=${config.cwd}`,
        }),
      onReady: handleBackendReady(runEffect, environment),
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
          yield* Effect.sync(() => {
            backendReady = false;
          });
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
  | DesktopEnvironment
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
  | DesktopBackendManager;

const desktopUpdateIpcActionsLayer = Layer.effect(
  DesktopUpdateIpcActions,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopUpdateIpcActionServices>();
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
        if (isQuitting) {
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
      }),
    });
  }),
);

const desktopWindowIpcActionsLayer = Layer.effect(
  DesktopWindowIpcActions,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    return DesktopWindowIpcActions.of({
      getAppBranding: Effect.succeed(environment.branding),
      getLocalEnvironmentBootstrap: Effect.sync(() => ({
        label: "Local environment",
        httpBaseUrl: getBackendHttpUrlHref(),
        wsBaseUrl: backendWsUrl || null,
        ...(backendBootstrapToken ? { bootstrapToken: backendBootstrapToken } : {}),
      })),
      pickFolder: (options) =>
        Effect.promise(async () => {
          const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
          const defaultPath = Option.getOrUndefined(
            environment.resolvePickFolderDefaultPath(options),
          );
          const openDialogOptions: OpenDialogOptions = {
            properties: ["openDirectory", "createDirectory"],
            ...(defaultPath ? { defaultPath } : {}),
          };
          const result = owner
            ? await dialog.showOpenDialog(owner, openDialogOptions)
            : await dialog.showOpenDialog(openDialogOptions);
          if (result.canceled) return null;
          return result.filePaths[0] ?? null;
        }),
      confirm: (message) =>
        Effect.promise(() =>
          showDesktopConfirmDialog(message, BrowserWindow.getFocusedWindow() ?? mainWindow),
        ),
      setTheme: (theme) =>
        Effect.sync(() => {
          nativeTheme.themeSource = theme;
        }),
      showContextMenu: ({ items, position }) =>
        Effect.promise(
          () =>
            new Promise<string | null>((resolve) => {
              const normalizedItems = normalizeContextMenuItems(items);
              if (normalizedItems.length === 0) {
                resolve(null);
                return;
              }

              const popupPosition =
                position &&
                Number.isFinite(position.x) &&
                Number.isFinite(position.y) &&
                position.x >= 0 &&
                position.y >= 0
                  ? {
                      x: Math.floor(position.x),
                      y: Math.floor(position.y),
                    }
                  : null;

              const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
              if (!window) {
                resolve(null);
                return;
              }

              const buildTemplate = (
                entries: readonly ContextMenuItem[],
              ): MenuItemConstructorOptions[] => {
                const template: MenuItemConstructorOptions[] = [];
                let hasInsertedDestructiveSeparator = false;
                for (const item of entries) {
                  if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
                    template.push({ type: "separator" });
                    hasInsertedDestructiveSeparator = true;
                  }
                  const itemOption: MenuItemConstructorOptions = {
                    label: item.label,
                    enabled: !item.disabled,
                  };
                  if (item.children && item.children.length > 0) {
                    itemOption.submenu = buildTemplate(item.children);
                  } else {
                    itemOption.click = () => resolve(item.id);
                  }
                  if (item.destructive && (!item.children || item.children.length === 0)) {
                    const destructiveIcon = getDestructiveMenuIcon();
                    if (destructiveIcon) {
                      itemOption.icon = destructiveIcon;
                    }
                  }
                  template.push(itemOption);
                }
                return template;
              };

              const menu = Menu.buildFromTemplate(buildTemplate(normalizedItems));
              menu.popup({
                window,
                ...popupPosition,
                callback: () => resolve(null),
              });
            }),
        ),
      openExternal: (rawUrl) => {
        const externalUrl = getSafeExternalUrl(rawUrl);
        if (!externalUrl) {
          return Effect.succeed(false);
        }

        return Effect.promise(() => shell.openExternal(externalUrl)).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      },
    });
  }),
);

const desktopSecretStorageLayer = Layer.succeed(
  DesktopSecretStorage,
  DesktopSecretStorage.of({
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
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

const desktopRuntimeLayer = Layer.mergeAll(
  desktopLoggerLayer,
  NetService.layer,
  desktopShellEnvironmentLayer,
  desktopSshEnvironmentLayer,
  DesktopIpc.layer,
  desktopServerExposureIpcActionsLayer,
  desktopUpdateIpcActionsLayer,
  desktopWindowIpcActionsLayer,
  desktopSecretStorageLayer,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(DesktopNetworkInterfacesLive),
  Layer.provideMerge(desktopBackendManagerLayer),
  Layer.provideMerge(desktopSshEnvironmentBridgeLayer),
  Layer.provideMerge(desktopEnvironmentLayer),
);

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
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

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

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

function resolveDesktopStaticDir(): Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const candidates = [
      environment.path.join(environment.appRoot, "apps/server/dist/client"),
      environment.path.join(environment.appRoot, "apps/web/dist"),
    ];
    for (const candidate of candidates) {
      const hasIndex = yield* fileSystem
        .exists(environment.path.join(candidate, "index.html"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasIndex) {
        return Option.some(candidate);
      }
    }
    return Option.none<string>();
  });
}

function normalizeDesktopProtocolPathname(rawPath: string): Option.Option<string> {
  const segments: string[] = [];
  for (const segment of rawPath.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return Option.none();
    }
    segments.push(segment);
  }
  return Option.some(segments.join("/"));
}

function resolveDesktopStaticPath(
  staticRoot: string,
  requestUrl: string,
): Effect.Effect<string, never, FileSystem.FileSystem | DesktopEnvironment> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment;
    const url = new URL(requestUrl);
    const rawPath = decodeURIComponent(url.pathname);
    const normalizedPath = normalizeDesktopProtocolPathname(rawPath);
    if (Option.isNone(normalizedPath)) {
      return environment.path.join(staticRoot, "index.html");
    }

    const requestedPath = normalizedPath.value.length > 0 ? normalizedPath.value : "index.html";
    const resolvedPath = environment.path.join(staticRoot, requestedPath);

    if (environment.path.extname(resolvedPath)) {
      return resolvedPath;
    }

    const nestedIndex = environment.path.join(resolvedPath, "index.html");
    const nestedIndexExists = yield* fileSystem
      .exists(nestedIndex)
      .pipe(Effect.orElseSucceed(() => false));
    if (nestedIndexExists) {
      return nestedIndex;
    }

    return environment.path.join(staticRoot, "index.html");
  });
}

function isStaticAssetRequest(requestUrl: string, environment: DesktopEnvironmentShape): boolean {
  try {
    const url = new URL(requestUrl);
    return environment.path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(
  stage: string,
  error: unknown,
): Effect.Effect<void, never, DesktopShutdown> {
  return Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown;
    const message = formatErrorMessage(error);
    const detail =
      error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    yield* logDesktopError("fatal startup error", {
      stage,
      message,
      ...(detail.length > 0 ? { detail } : {}),
    });
    yield* Effect.sync(() => {
      if (!isQuitting) {
        isQuitting = true;
        dialog.showErrorBox("T3 Code failed to start", `Stage: ${stage}\n${message}${detail}`);
      }
    });
    yield* shutdown.request;
    yield* Effect.sync(() => {
      app.quit();
    });
  });
}

function registerDesktopProtocol(): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (environment.isDevelopment || desktopProtocolRegistered) return;
    const context = yield* Effect.context<FileSystem.FileSystem | DesktopEnvironment>();
    const runProtocolEffect = makeDesktopEffectRunner(context);

    const staticRoot = yield* resolveDesktopStaticDir();
    if (Option.isNone(staticRoot)) {
      return yield* Effect.fail(
        new Error("Desktop static bundle missing. Build apps/server (with bundled client) first."),
      );
    }

    const staticRootResolved = environment.path.resolve(staticRoot.value);
    const staticRootPrefix = `${staticRootResolved}${environment.path.sep}`;
    const fallbackIndex = environment.path.join(staticRootResolved, "index.html");

    yield* Effect.sync(() => {
      protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
        const resolution = Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const candidate = yield* resolveDesktopStaticPath(staticRootResolved, request.url);
          const environment = yield* DesktopEnvironment;
          const resolvedCandidate = environment.path.resolve(candidate);
          const isInRoot =
            resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
          const isAssetRequest = isStaticAssetRequest(request.url, environment);
          const exists = yield* fileSystem
            .exists(resolvedCandidate)
            .pipe(Effect.orElseSucceed(() => false));

          if (!isInRoot || !exists) {
            return isAssetRequest ? ({ error: -6 } as const) : ({ path: fallbackIndex } as const);
          }

          return { path: resolvedCandidate } as const;
        }).pipe(Effect.catch(() => Effect.succeed({ path: fallbackIndex } as const)));

        void runProtocolEffect(resolution).then(callback, () => {
          callback({ path: fallbackIndex });
        });
      });

      desktopProtocolRegistered = true;
    });
  });
}

function dispatchMenuAction(
  action: string,
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow(runEffect, environment);
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    revealWindow(targetWindow);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment: environment.isDevelopment,
    isPackaged: app.isPackaged,
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
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow(runEffect, environment);
  }
  void runEffect(checkForUpdatesFromMenu());
}

function hasDesktopUpdateFeedConfig(): boolean {
  return Option.isSome(appUpdateYmlConfig) || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
}

function checkForUpdatesFromMenu(): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* checkForUpdates("menu");

    if (updateState.status === "up-to-date") {
      yield* Effect.promise(() =>
        dialog.showMessageBox({
          type: "info",
          title: "You're up to date!",
          message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
          buttons: ["OK"],
        }),
      );
    } else if (updateState.status === "error") {
      yield* Effect.promise(() =>
        dialog.showMessageBox({
          type: "warning",
          title: "Update check failed",
          message: "Could not check for updates.",
          detail: updateState.message ?? "An unknown error occurred. Please try again later.",
          buttons: ["OK"],
        }),
      );
    }
  });
}

function configureApplicationMenu(): Effect.Effect<void, never, DesktopWindowBoundaryServices> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const context = yield* Effect.context<DesktopWindowBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    const template: MenuItemConstructorOptions[] = [];

    if (process.platform === "darwin") {
      template.push({
        label: app.name,
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
            click: () => dispatchMenuAction("open-settings", runEffect, environment),
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
                  click: () => dispatchMenuAction("open-settings", runEffect, environment),
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
  FileSystem.FileSystem | DesktopEnvironment
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const commitHash = yield* resolveAboutCommitHash();
    yield* Effect.sync(() => {
      app.setName(environment.displayName);
      app.setAboutPanelOptions({
        applicationName: environment.displayName,
        applicationVersion: environment.appVersion,
        version: Option.getOrElse(commitHash, () => "unknown"),
      });

      if (process.platform === "win32") {
        app.setAppUserModelId(environment.appUserModelId);
      }

      if (process.platform === "linux") {
        (app as LinuxDesktopNamedApp).setDesktopName?.(environment.linuxDesktopEntryName);
      }

      if (process.platform === "darwin" && app.dock) {
        const iconPath = Option.getOrUndefined(desktopIconPaths.png);
        if (iconPath) {
          app.dock.setIcon(iconPath);
        }
      }
    });
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

function startUpdatePollers(): Effect.Effect<void, never, Scope.Scope> {
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

function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  if (!window.isVisible()) {
    window.show();
  }

  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }

  window.focus();
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
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
      hasUpdateFeedConfig: hasDesktopUpdateFeedConfig(),
    }) === null
  );
}

function checkForUpdates(reason: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
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
  DesktopBackendManager
> {
  return Effect.gen(function* () {
    if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
      return { accepted: false, completed: false };
    }

    isQuitting = true;
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
            isQuitting = false;
            setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
          });
          yield* logUpdaterError("failed to install update", { message });
          return { accepted: true, completed: false };
        }),
      ),
    );
  });
}

function configureAutoUpdater(): Effect.Effect<void, never, Scope.Scope | DesktopEnvironment> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
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
        isQuitting = false;
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

function startBackend(): Effect.Effect<void, never, DesktopBackendManager> {
  if (isQuitting) return Effect.void;
  return Effect.gen(function* () {
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
  if (isQuitting) return;
  isQuitting = true;
  void runEffect(
    logDesktopInfo("process signal received", { signal }).pipe(
      Effect.andThen(requestDesktopShutdownAndWait()),
    ),
  ).finally(() => {
    app.quit();
  });
}

function registerIpcHandlers() {
  return Effect.gen(function* () {
    const desktopSshEnvironmentBridge = yield* DesktopSshEnvironmentBridge;
    yield* installDesktopIpcHandlers;
    yield* desktopSshEnvironmentBridge.registerIpcHandlers(ipcMain);
  });
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

function syncAllWindowAppearance(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    syncWindowAppearance(window);
  }
}

function createWindow(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
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

    const externalUrl = getSafeExternalUrl(params.linkURL);
    if (externalUrl) {
      menuTemplate.push(
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
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
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
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
  bindFirstRevealTrigger(revealSubscribers, () => revealWindow(window));

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
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function bootstrap() {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
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

    yield* registerIpcHandlers();
    yield* logDesktopInfo("bootstrap ipc handlers registered");
    yield* startBackend();
    yield* logDesktopInfo("bootstrap backend start requested");

    if (environment.isDevelopment) {
      mainWindow = createWindow(runEffect, environment);
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
  isQuitting = true;
  void runEffect(logDesktopInfo("before-quit received"));
  if (allowQuit()) {
    return;
  }

  event.preventDefault();
  void runEffect(requestDesktopShutdownAndWait()).finally(() => {
    markQuitAllowed();
    app.quit();
  });
}

function handleActivate(
  runEffect: DesktopEffectRunner,
  environment: DesktopEnvironmentShape,
): void {
  const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (existingWindow) {
    revealWindow(existingWindow);
    return;
  }
  if (environment.isDevelopment) {
    mainWindow = createWindow(runEffect, environment);
    return;
  }
  createBackendWindowIfReady(runEffect, environment);
}

function handleWindowAllClosed(): void {
  if (process.platform !== "darwin" && !isQuitting) {
    app.quit();
  }
}

function registerDesktopLifecycleHandlers(): Effect.Effect<
  void,
  never,
  Scope.Scope | DesktopLifecycleBoundaryServices
> {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleBoundaryServices>();
    const runEffect = makeDesktopEffectRunner(context);
    let quitAllowed = false;
    yield* addScopedListener(nativeTheme, "updated", () => {
      syncAllWindowAppearance();
    });
    yield* addScopedListener(app, "before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* addScopedListener(app, "activate", () => {
      handleActivate(runEffect, environment);
    });
    yield* addScopedListener(app, "window-all-closed", () => {
      handleWindowAllClosed();
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

const waitForElectronReady = Effect.promise(() => app.whenReady()).pipe(Effect.asVoid);

const program = Effect.scoped(
  Effect.gen(function* () {
    const shutdown = yield* makeDesktopShutdown;

    yield* Effect.gen(function* () {
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
      yield* Effect.sync(() => {
        // Must happen before Electron's ready event so Chromium profile data
        // lands in the desktop-specific userData directory.
        app.setPath("userData", userDataPath);
      });
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
        app.commandLine.appendSwitch("class", environment.linuxWmClass);
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

program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
