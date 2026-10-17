import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";
import * as Crypto from "effect/Crypto";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
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
import * as DesktopState from "./DesktopState.ts";
import * as DesktopRemoteUpdates from "../updates/DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4()),
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
      "T3 Code failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

export const stopAllPoolInstances = Effect.fn("desktop.app.stopAllPoolInstances")(
  function* (): Effect.fn.Return<void, never, DesktopBackendPool.DesktopBackendPool> {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    yield* Effect.forEach(
      instances,
      (instance) => instance.stop({ timeout: Duration.seconds(5) }),
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
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  // A quit during shell startup must prevent subsequent bootstrap work.
  const awaitShellEnvironment = Effect.raceFirst(
    shellEnvironment.installIntoProcess.pipe(Effect.as(true)),
    shutdown.awaitRequest.pipe(Effect.as(false)),
  );
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

  if (!settings.localEnvironmentEnabled) {
    yield* logBootstrapInfo("bootstrap skipping local environment (disabled in settings)");
    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.createMainIfBackendReady;
    }
    // Snap Shot reads the desktop session variables the login shell provides.
    if (!(yield* awaitShellEnvironment)) return;
    yield* snapShot.initialize;
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

  if (!(yield* Ref.get(state.quitting))) {
    const wslOnly = settings.wslOnly === true && settings.wslBackendEnabled === true;
    // The main window waits for the primary backend. In wsl-only mode that is
    // the WSL backend, which can be slow to cold-boot — show a "Connecting to
    // WSL" splash immediately so the app feels responsive instead of presenting
    // no window until WSL is ready. (Dual mode opens fast off the Windows
    // primary, so no splash there.)
    if (wslOnly) {
      yield* desktopWindow.showConnectingSplash;
      // Resolving the WSL primary's config runs wsl.exe.
      if (!(yield* awaitShellEnvironment)) return;
    }
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    // Publish the endpoint and token before preload reads them. Backend readiness
    // retries a failed window open; WSL keeps its splash until then.
    if (!wslOnly) {
      yield* desktopWindow.ensureMain.pipe(
        Effect.catch((error) =>
          logBootstrapWarning("failed to open main window while the backend starts", {
            error: error.message,
          }),
        ),
      );
    }
    // Snap Shot reads the desktop session variables the login shell provides.
    if (!(yield* awaitShellEnvironment)) return;
    yield* snapShot.initialize;
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
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const state = yield* DesktopState.DesktopState;

  // Chromium already chose secret storage from the pre-ready environment.
  const linuxElectronOptions = preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore:
        preReadyElectronOptions.linuxPasswordStoreCommandLine !== null
          ? "command-line"
          : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }
  // Open the window while the shell loads; spawning work awaits the same run.
  yield* Effect.forkScoped(shellEnvironment.installIntoProcess);
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });
  yield* desktopSettings.load;

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* clerk.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  if (environment.platform === "linux") {
    yield* Effect.forkScoped(
      shellEnvironment.secretStorageReady.pipe(
        Effect.andThen(safeStorage.selectedStorageBackend),
        Effect.flatMap((selectedBackend) =>
          logStartupInfo("safe storage ready", {
            backend: Option.getOrElse(selectedBackend, () => "unknown"),
          }),
        ),
      ),
    );
  }
  yield* appIdentity.configure;
  yield* previewPasskeys.configure;
  yield* applicationMenu.configure;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
  if (yield* Ref.get(state.quitting)) return;
  yield* updates.configure;
  yield* DesktopRemoteUpdates.listen;
  yield* linuxUrlHandler.register;
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;

    yield* Effect.addFinalizer(() =>
      // Stop every backend in the pool, not just the primary. The
      // electronApp.quit() path can race ahead of the layer-scope
      // cascade, so leaving the WSL instance for its parent scope
      // finalizer means it gets hard-killed by the OS instead of
      // receiving SIGTERM + grace.
      stopAllPoolInstances().pipe(
        Effect.ensuring(rendererHistory.shutdown),
        Effect.ensuring(shutdown.markComplete),
      ),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
