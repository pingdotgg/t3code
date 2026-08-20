import * as Cause from "effect/Cause";
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
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedErrorClass<DesktopBackendPortUnavailableError>()(
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

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedErrorClass<DesktopDevelopmentBackendPortRequiredError>()(
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

// `portsHeldInDistro` is non-empty only when the primary backend will bind
// inside a WSL distro. The host probes below run in the Electron main process,
// which is the Windows side, and WSL2's localhost forwarding does not reserve a
// WSL-side listener's port in the Windows port namespace — so a port that binds
// fine here can still be taken in the distro the backend actually runs in.
export const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
  portsHeldInDistro: ReadonlySet<number>,
) {
  if (Option.isSome(configuredPort)) {
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  const net = yield* NetService.NetService;
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    if (portsHeldInDistro.has(port)) continue;
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

const bootstrap = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const primaryBackend = yield* pool.primary;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* logBootstrapInfo("bootstrap start");

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const settings = yield* desktopSettings.get;
  // wsl-only mode hands this port to a backend that binds inside the distro, so
  // the port has to be free on both sides. Ask the distro what it already holds
  // before scanning; every consumer of the port (the renderer origin registered
  // below, the advertised endpoints, the backend's own bind) derives from the
  // single value chosen here, so this is the only place it can be corrected.
  // Both steps are skipped once something has already asked the app to quit:
  // the splash would paint a window on the way out, and the probe's wsl.exe
  // cold start is seconds of work for a port nobody will bind.
  const startingWslPrimary =
    settings.wslOnly === true &&
    settings.wslBackendEnabled === true &&
    !(yield* Ref.get(state.quitting));
  if (startingWslPrimary) {
    // In wsl-only mode the renderer is served by the WSL backend, which can be
    // slow to cold-boot — show a "Connecting to WSL" splash instead of
    // presenting no window until WSL is ready. (Dual mode opens fast off the
    // Windows primary, so no splash there.) It goes up before the port probe
    // below because that probe is what cold-starts the VM.
    yield* desktopWindow.showConnectingSplash;
  }
  const distroPorts =
    startingWslPrimary && (yield* wslEnvironment.isAvailable)
      ? yield* wslEnvironment.probeListeningPorts(settings.wslDistro)
      : Option.none<ReadonlySet<number>>();
  if (startingWslPrimary && Option.isNone(distroPorts)) {
    // Worth a warning rather than a quiet field on the info line below: the
    // fallback is the Windows-only scan, which for a WSL primary is exactly the
    // unsound check this probe replaces. If the backend then dies on
    // EADDRINUSE, this is the line that explains why we did not know better.
    yield* logBootstrapWarning(
      "could not read the WSL distro's listening ports; falling back to a Windows-only port scan",
      { distro: settings.wslDistro },
    );
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(
    environment.configuredBackendPort,
    Option.getOrElse(distroPorts, () => new Set<number>()),
  );
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
      // A failed probe is not a guarantee that the distro is clear; the child
      // can still lose the race and hit EADDRINUSE at launch.
      ...(startingWslPrimary ? { wslDistroPortsProbed: Option.isSome(distroPorts) } : {}),
    },
  );
  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const rendererTarget = environment.isDevelopment
    ? Option.getOrThrow(environment.devServerUrl)
    : backendConfig.httpBaseUrl;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    targetOrigin: rendererTarget,
    backendOrigin: backendConfig.httpBaseUrl,
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    // Bring up the WSL backend if the user previously enabled it. The
    // primary is already starting; reconcile fires off the WSL register
    // in parallel rather than blocking primary readiness on a possibly
    // slow first wsl.exe spawn.
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

  yield* shellEnvironment.installIntoProcess;
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess()
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
  yield* desktopSettings.load;

  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* clerk.configure;

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
  yield* applicationMenu.configure;
  yield* updates.configure;
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        // Stop every backend in the pool, not just the primary. The
        // electronApp.quit() path can race ahead of the layer-scope
        // cascade, so leaving the WSL instance for its parent scope
        // finalizer means it gets hard-killed by the OS instead of
        // receiving SIGTERM + grace. Stops run concurrently.
        const instances = yield* pool.list;
        yield* Effect.forEach(instances, (instance) => instance.stop(), {
          concurrency: "unbounded",
        });
      }).pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
