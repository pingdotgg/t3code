import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts/settings";

import * as NetService from "@t3tools/shared/Net";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as ComputerHistoryManager from "../computerHistory/ComputerHistoryManager.ts";
import { ensureChromeNativeHostRegistered } from "../computerUse/nativeHost.ts";
import { scheduleChromeExtensionAutoInstall } from "../computerUse/chromeExtensionSetup.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopDeepLink from "./DesktopDeepLink.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopStartupRecovery from "./DesktopStartupRecovery.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopRemoteUpdates from "../updates/DesktopRemoteUpdates.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import { desktopAppDisplayName } from "./desktopDistro.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const LinuxDesktopSessionConfig = Config.all({
  current: Config.String("XDG_CURRENT_DESKTOP").pipe(Config.option),
  session: Config.String("XDG_SESSION_DESKTOP").pipe(Config.option),
});

const makeDesktopRunId = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.uuidV4()),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {
    startPort: Schema.Int,
    maxPort: Schema.Int,
    hosts: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedError<DesktopDevelopmentBackendPortRequiredError>()(
  "DesktopDevelopmentBackendPortRequiredError",
  {},
) {
  override get message(): string {
    return "T3CODE_PORT is required in desktop development.";
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
) {
  if (Option.isSome(configuredPort)) {
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  const net = yield* NetService.NetService;
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    let availableOnEveryHost = true;

    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        availableOnEveryHost = false;
        break;
      }
    }

    if (availableOnEveryHost) {
      return {
        port,
        selectedByScan: true,
      } as const;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: MAX_TCP_PORT,
    hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
  });
});

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      `${desktopAppDisplayName()} failed to start`,
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

const stopAllPoolInstances = Effect.fn("desktop.app.stopAllPoolInstances")(
  function* (): Effect.fn.Return<void, never, DesktopBackendPool.DesktopBackendPool> {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    yield* Effect.forEach(
      instances,
      (instance) => instance.stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT }),
      { concurrency: "unbounded" },
    );
  },
);

const bootstrap = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  const appActivation = yield* DesktopAppActivation.DesktopAppActivation;
  yield* logBootstrapInfo("bootstrap start");

  const settings = yield* desktopSettings.get;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(environment.isDevelopment
      ? { targetOrigin: Option.getOrThrow(environment.devServerUrl) }
      : { assetDirectory: environment.clientAssetsDir }),
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");
  // Before any window: the preload merges these items before the app reads storage.
  yield* (yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage).load(
    yield* (yield* DesktopAppIdentity.DesktopAppIdentity).resolveUserDataPath,
  );

  yield* snapShot.initialize;

  if (!settings.localEnvironmentEnabled) {
    yield* logBootstrapInfo("bootstrap skipping local environment (disabled in settings)");
    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.createMainIfBackendReady;
    }
    return;
  }

  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const primaryBackend = yield* pool.primary;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (
    settings.serverExposureMode === "network-accessible" &&
    serverExposureState.mode === "local-only"
  ) {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  // Start the Computer History recorder when already enabled so capture resumes
  // after relaunch without requiring a visit to Settings.
  yield* Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem
      .readFileString(environment.serverSettingsPath)
      .pipe(Effect.orElseSucceed(() => "{}"));
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ServerSettings))(raw).pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    );
    // ensureDaemon keeps ComputerHistoryOperationError in the error channel so
    // bootstrap can Effect.catch without turning spawn/layout failures into defects.
    const manager = yield* ComputerHistoryManager.ComputerHistoryManager;
    yield* manager.ensureDaemon(environment.stateDir, decoded.computerHistory).pipe(
      Effect.catchTags({
        ComputerHistoryOperationError: (cause) =>
          Effect.logWarning("Computer History daemon bootstrap skipped", { cause }),
      }),
    );
    // Browser control needs MT Code's Chrome native host registered; do it now
    // (in the background) so it works without a visit to Settings.
    if (decoded.desktopControl.enabled && decoded.desktopControl.browserControlEnabled) {
      void ensureChromeNativeHostRegistered();
      // And load the extension itself into Chrome, once, so a new install
      // needs no trip to chrome://extensions.
      scheduleChromeExtensionAutoInstall({
        stateDir: environment.stateDir,
        isDevelopment: environment.isDevelopment,
      });
    }
  });

  if (!(yield* Ref.get(state.quitting))) {
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    // WSL-only fallback can change the primary endpoint before readiness.
    const config = yield* primaryBackend.currentConfig;
    if (
      !environment.isDevelopment &&
      !settings.wslOnly &&
      Option.isSome(config) &&
      Option.isNone(config.value.preflightFailure)
    ) {
      yield* desktopWindow.ensureMain;
    }
    yield* appActivation.start.pipe(
      Effect.tap(() => logBootstrapInfo("desktop app control socket ready")),
      Effect.catch((error) => logStartupError("desktop app control socket unavailable", { error })),
    );
    yield* Effect.forkScoped(wslBackend.reconcile);
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const linuxUrlHandler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
  const clerk = yield* DesktopClerk.DesktopClerk;
  const deepLink = yield* DesktopDeepLink.DesktopDeepLink;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const tray = yield* DesktopTray.DesktopTray;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;

  const startupSettings = yield* desktopSettings.load;
  yield* shellEnvironment.installIntoProcess({
    mode: startupSettings.shellEnvironmentMode,
    names: startupSettings.shellEnvironmentNames,
  });
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess(
          yield* HostProcess.HomeDirectory,
        )
      : preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null && !hasCommandLinePasswordStore) {
    if (
      linuxElectronOptions.passwordStore !== null ||
      preReadyElectronOptions.linux?.passwordStore !== null
    ) {
      yield* electronApp.removeCommandLineSwitch("password-store");
    }
    if (linuxElectronOptions.passwordStore !== null) {
      yield* electronApp.appendCommandLineSwitch(
        "password-store",
        linuxElectronOptions.passwordStore,
      );
    }
  }
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });

  if (linuxElectronOptions !== null) {
    const xdgDesktop = yield* LinuxDesktopSessionConfig;
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: Option.getOrNull(xdgDesktop.current),
      xdgSessionDesktop: Option.getOrNull(xdgDesktop.session),
    });
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* clerk.configure;
  // Before whenReady: macOS emits open-url for a cold-start link as soon as
  // the app finishes launching, so the listener has to exist by then.
  yield* deepLink.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  if (environment.platform === "linux") {
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    yield* logStartupInfo("safe storage ready", {
      backend: Option.getOrElse(selectedBackend, () => "unknown"),
    });
  }
  yield* appIdentity.configure;
  yield* previewPasskeys.configure;
  yield* applicationMenu.configure;
  yield* tray.configure;
  yield* updates.configure;
  yield* DesktopRemoteUpdates.listen;
  yield* DesktopStartupRecovery.listen;
  // Portal identity is prepared pre-ready; MIME helpers must not gate the backend or window.
  yield* linuxUrlHandler.register.pipe(Effect.forkScoped);
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // electronApp.quit() can race ahead of the layer-scope cascade — stop
        // Computer History here the same way we stop backends, so the recorder
        // receives SIGTERM instead of surviving or being hard-killed.
        const history = yield* ComputerHistoryManager.ComputerHistoryManager;
        yield* history.stopDaemon().pipe(Effect.ignore);
        // Stop every backend in the pool, not just the primary. The
        // electronApp.quit() path can race ahead of the layer-scope
        // cascade, so leaving the WSL instance for its parent scope
        // finalizer means it gets hard-killed by the OS instead of
        // receiving SIGTERM + grace. Upstream's helper also bounds the wait.
        yield* stopAllPoolInstances();
      }).pipe(
        Effect.ensuring(rendererHistory.shutdown),
        Effect.ensuring(shutdown.markComplete),
        Effect.withSpan("desktop.app.shutdown"),
      ),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
