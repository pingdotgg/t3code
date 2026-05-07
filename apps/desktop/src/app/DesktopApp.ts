import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

import * as NetService from "@t3tools/shared/Net";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopServerExposure from "../serverExposure/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Random.nextUUIDv4.pipe(
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

class DesktopBackendPortUnavailableError extends Data.TaggedError(
  "DesktopBackendPortUnavailableError",
)<{
  readonly startPort: number;
  readonly maxPort: number;
  readonly hosts: readonly string[];
}> {
  override get message() {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

class DesktopDevelopmentBackendPortRequiredError extends Data.TaggedError(
  "DesktopDevelopmentBackendPortRequiredError",
)<{}> {
  override get message() {
    return "T3CODE_PORT is required in desktop development.";
  }
}

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

const handleFatalStartupError = (
  stage: string,
  error: unknown,
): Effect.Effect<
  void,
  never,
  | DesktopLifecycle.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopLifecycle.DesktopShutdown;
    const state = yield* DesktopState.DesktopState;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    yield* Effect.logError("fatal startup error").pipe(
      Effect.annotateLogs({
        stage,
        message,
        ...(detail.length > 0 ? { detail } : {}),
      }),
    );
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
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  yield* Effect.logInfo("bootstrap start");

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* Effect.logInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
  ).pipe(
    Effect.annotateLogs({
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    }),
  );

  const settings = yield* desktopSettings.get;
  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* Effect.logInfo("bootstrap restoring persisted server exposure mode").pipe(
      Effect.annotateLogs({ mode: settings.serverExposureMode }),
    );
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* Effect.logInfo("bootstrap resolved backend endpoint").pipe(
    Effect.annotateLogs({ baseUrl: backendConfig.httpBaseUrl.href }),
  );
  if (serverExposureState.endpointUrl) {
    yield* Effect.logInfo("bootstrap enabled network access").pipe(
      Effect.annotateLogs({ endpointUrl: serverExposureState.endpointUrl }),
    );
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* Effect.logWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers;
  yield* Effect.logInfo("bootstrap ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    yield* backendManager.start;
    yield* Effect.logInfo("bootstrap backend start requested");
  }
});

export const program = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });

    const shutdown = yield* DesktopLifecycle.DesktopShutdown;
    const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
    const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;

    yield* Effect.addFinalizer(() =>
      backendManager.stop().pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* shellEnvironment.installIntoProcess;
    const userDataPath = yield* appIdentity.resolveUserDataPath;
    yield* electronApp.setPath("userData", userDataPath);
    yield* Effect.logInfo("runtime logging configured").pipe(
      Effect.annotateLogs({ logDir: environment.logDir }),
    );
    yield* desktopSettings.load;

    if (environment.platform === "linux") {
      yield* electronApp.appendCommandLineSwitch("class", environment.linuxWmClass);
    }

    yield* appIdentity.configure;
    yield* lifecycle.register;

    yield* electronApp.whenReady.pipe(
      Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
    );
    yield* Effect.logInfo("app ready");
    yield* appIdentity.configure;
    yield* applicationMenu.configure;
    yield* electronProtocol.registerDesktopFileProtocol;
    yield* updates.configure;
    yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
    yield* shutdown.awaitRequest;
  }),
);
