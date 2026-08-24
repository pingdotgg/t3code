import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

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
import * as DesktopBackendPort from "../backend/DesktopBackendPort.ts";
import * as DesktopExistingLocalBackendStartup from "../backend/DesktopExistingLocalBackendStartup.ts";
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

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

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
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* logBootstrapInfo("bootstrap start");

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const settings = yield* desktopSettings.get;
  const existingLocalBackendSelection =
    yield* DesktopExistingLocalBackendStartup.resolveExistingLocalBackendForStartup;
  if (existingLocalBackendSelection._tag === "Quit") {
    yield* Ref.set(state.quitting, true);
    yield* shutdown.request;
    yield* electronApp.quit;
    return;
  }
  const existingLocalBackend = existingLocalBackendSelection.attachment;
  const backendPortSelection = Option.isSome(existingLocalBackend)
    ? ({ port: existingLocalBackend.value.backend.port, selectedByScan: false } as const)
    : yield* DesktopBackendPort.resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  if (Option.isSome(existingLocalBackend)) {
    yield* logBootstrapInfo("attaching to existing local backend", {
      origin: existingLocalBackend.value.backend.origin,
      port: existingLocalBackend.value.backend.port,
      baseDir: existingLocalBackend.value.backend.baseDir,
    });
  } else {
    yield* logBootstrapInfo(
      backendPortSelection.selectedByScan
        ? "selected backend port via sequential scan"
        : "using configured backend port",
      {
        port: backendPort,
        ...(backendPortSelection.selectedByScan
          ? { startPort: DesktopBackendPort.DEFAULT_DESKTOP_BACKEND_PORT }
          : {}),
      },
    );
  }
  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const backendOrigin = Option.match(existingLocalBackend, {
    onNone: () => backendConfig.httpBaseUrl,
    onSome: ({ backend }) => new URL(backend.origin),
  });
  const rendererTarget = environment.isDevelopment
    ? Option.getOrThrow(environment.devServerUrl)
    : Option.match(existingLocalBackend, {
        onNone: () => backendConfig.httpBaseUrl,
        onSome: ({ backend }) => new URL(backend.origin),
      });
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    targetOrigin: rendererTarget,
    backendOrigin,
    ...(environment.isDevelopment || Option.isNone(existingLocalBackend)
      ? {}
      : {
          rendererRoot: environment.path.join(environment.serverRoot, "apps/server/dist/client"),
        }),
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendOrigin.href,
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
    // In wsl-only mode the renderer is served by the WSL backend, which can be
    // slow to cold-boot — show a "Connecting to WSL" splash immediately so the
    // app feels responsive instead of presenting no window until WSL is ready.
    // (Dual mode opens fast off the Windows primary, so no splash there.)
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
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
