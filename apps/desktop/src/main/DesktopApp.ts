import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as NetService from "@t3tools/shared/Net";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopRun from "./DesktopRun.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopSettingsState from "./DesktopSettingsState.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

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

  return yield* Effect.fail(
    new DesktopBackendPortUnavailableError({
      startPort: DEFAULT_DESKTOP_BACKEND_PORT,
      maxPort: MAX_TCP_PORT,
      hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
    }),
  );
});

const handleFatalStartupError = (
  stage: string,
  error: unknown,
): Effect.Effect<
  void,
  never,
  | DesktopLifecycle.DesktopShutdown
  | DesktopRun.DesktopRun
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopLifecycle.DesktopShutdown;
    const state = yield* DesktopState.DesktopState;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const run = yield* DesktopRun.DesktopRun;
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    yield* run.logError("fatal startup error", {
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

const fatalStartupCause = (stage: string, cause: Cause.Cause<unknown>) =>
  handleFatalStartupError(stage, new Error(Cause.pretty(cause))).pipe(
    Effect.andThen(Effect.failCause(cause)),
  );

const bootstrap = Effect.gen(function* () {
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const state = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settingsState = yield* DesktopSettingsState.DesktopSettingsState;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const run = yield* DesktopRun.DesktopRun;
  yield* run.logInfo("bootstrap start");

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* Effect.fail(new Error("T3CODE_PORT is required in desktop development."));
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* run.logInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  const settings = yield* settingsState.get;
  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* run.logInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  yield* run.logInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* run.logInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* run.logWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers;
  yield* run.logInfo("bootstrap ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    yield* backendManager.start;
  }
  yield* run.logInfo("bootstrap backend start requested");

  if (environment.isDevelopment) {
    yield* desktopWindow.ensureMain;
  }
});

export const program = Effect.scoped(
  Effect.gen(function* () {
    const shutdown = yield* DesktopLifecycle.DesktopShutdown;

    yield* Effect.gen(function* () {
      const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
      const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
      const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
      const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
      const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
      const settingsState = yield* DesktopSettingsState.DesktopSettingsState;
      const updates = yield* DesktopUpdates.DesktopUpdates;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const run = yield* DesktopRun.DesktopRun;

      yield* electronProtocol.registerDesktopSchemePrivileges;
      yield* run.refreshId;
      yield* Scope.addFinalizer(
        yield* Scope.Scope,
        Effect.zip(backendManager.shutdown, updates.shutdown).pipe(
          Effect.ensuring(shutdown.markComplete),
        ),
      );

      yield* shellEnvironment.installIntoProcess;
      const userDataPath = yield* appIdentity.resolveUserDataPath;
      yield* electronApp.setPath("userData", userDataPath);
      yield* run.logInfo("runtime logging configured", { logDir: environment.logDir });
      yield* settingsState.load;

      if (environment.platform === "linux") {
        yield* electronApp.appendCommandLineSwitch("class", environment.linuxWmClass);
      }

      yield* appIdentity.configure;
      yield* lifecycle.register;

      yield* electronApp.whenReady.pipe(
        Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
      );
      yield* run.logInfo("app ready");
      yield* appIdentity.configure;
      yield* applicationMenu.configure;
      yield* electronProtocol.registerDesktopFileProtocol;
      yield* updates.configure;
      yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
      yield* shutdown.awaitRequest;
    });
  }),
);
