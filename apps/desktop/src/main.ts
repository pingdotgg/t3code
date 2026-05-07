import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as EffectPath from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as NetService from "@t3tools/shared/Net";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

import type { DesktopSettings } from "./desktopSettings.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import { DesktopServerExposureIpcActions } from "./ipc/methods/serverExposure.ts";
import { DesktopUpdateIpcActions } from "./ipc/methods/updates.ts";
import * as DesktopWindowIpcActionsLive from "./ipc/methods/windowLive.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as DesktopSecretStorage from "./electron/ElectronSafeStorage.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopApp from "./main/DesktopApp.ts";
import * as DesktopAppIdentity from "./main/DesktopAppIdentity.ts";
import * as DesktopApplicationMenu from "./main/DesktopApplicationMenu.ts";
import * as DesktopAssets from "./main/DesktopAssets.ts";
import * as DesktopBackendConfiguration from "./main/DesktopBackendConfiguration.ts";
import * as DesktopBackendEvents from "./main/DesktopBackendEvents.ts";
import * as DesktopBackendManager from "./main/DesktopBackendManager.ts";
import * as DesktopConfig from "./main/DesktopConfig.ts";
import * as DesktopEnvironment from "./main/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./main/DesktopLifecycle.ts";
import { DesktopBackendOutputLogLive, DesktopLoggerLive } from "./main/DesktopLogging.ts";
import * as DesktopRun from "./main/DesktopRun.ts";
import * as DesktopServerExposure from "./main/DesktopServerExposure.ts";
import * as DesktopSettingsState from "./main/DesktopSettingsState.ts";
import * as DesktopShellEnvironment from "./main/DesktopShellEnvironment.ts";
import * as DesktopShutdown from "./main/DesktopShutdown.ts";
import * as DesktopSshEnvironment from "./main/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./main/DesktopSshPasswordPrompts.ts";
import * as DesktopSshRemoteApi from "./main/DesktopSshRemoteApi.ts";
import * as DesktopState from "./main/DesktopState.ts";
import * as DesktopUpdates from "./main/DesktopUpdates.ts";
import * as DesktopWindow from "./main/DesktopWindow.ts";

const desktopConfigLayer = DesktopConfig.layer;

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const metadata = yield* electronApp.metadata;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      cwd: process.cwd(),
      platform: process.platform,
      processArch: process.arch,
      ...metadata,
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(EffectPath.layer, ElectronApp.layer, desktopConfigLayer)));

const desktopLoggerLayer = DesktopLoggerLive.pipe(Layer.provide(NodeServices.layer));

const desktopBackendOutputLogLayer = DesktopBackendOutputLogLive.pipe(
  Layer.provide(NodeServices.layer),
);

const resolveDesktopSshCliRunner = (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
  settings: DesktopSettings,
): RemoteT3RunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: devRemoteEntryPath };
  }
  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: environment.appVersion,
      updateChannel: settings.updateChannel,
      isDevelopment: environment.isDevelopment,
    }),
  };
};

const desktopSshEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const settingsState = yield* DesktopSettingsState.DesktopSettingsState;
    return DesktopSshEnvironment.layer({
      resolveCliRunner: settingsState.get.pipe(
        Effect.map((settings) => resolveDesktopSshCliRunner(environment, settings)),
      ),
    });
  }),
);

const desktopSshRuntimeLayer = Layer.mergeAll(
  desktopSshEnvironmentLayer,
  DesktopSshRemoteApi.layer,
).pipe(Layer.provideMerge(DesktopSshPasswordPrompts.layer()), Layer.provideMerge(NetService.layer));

const desktopShellEnvironmentLayer = DesktopShellEnvironment.layer;

const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(DesktopAssets.layer));

const desktopAppIdentityLayer = DesktopAppIdentity.layer.pipe(
  Layer.provideMerge(DesktopAssets.layer),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(DesktopServerExposure.networkInterfacesLayer),
  Layer.provideMerge(desktopConfigLayer),
  Layer.provideMerge(DesktopSettingsState.layer),
  Layer.provideMerge(desktopEnvironmentLayer),
);

const desktopServerExposureIpcActionsLayer = Layer.effect(
  DesktopServerExposureIpcActions,
  Effect.gen(function* () {
    const context = yield* Effect.context<DesktopLifecycle.DesktopLifecycleRuntimeServices>();
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    return DesktopServerExposureIpcActions.of({
      getState: serverExposure.getState,
      setMode: (nextMode) =>
        Effect.gen(function* () {
          const change = yield* serverExposure.setMode(nextMode);
          if (change.requiresRelaunch) {
            yield* lifecycle.relaunch(`serverExposureMode=${nextMode}`);
          }
          return change.state;
        }).pipe(Effect.provide(context)),
      setTailscaleServeEnabled: (input) =>
        Effect.gen(function* () {
          const change = yield* serverExposure.setTailscaleServeEnabled(input);
          if (change.requiresRelaunch) {
            yield* lifecycle.relaunch(
              change.state.tailscaleServeEnabled
                ? "tailscale-serve-enabled"
                : "tailscale-serve-disabled",
            );
          }
          return change.state;
        }).pipe(Effect.provide(context)),
      getAdvertisedEndpoints: serverExposure.getAdvertisedEndpoints,
    });
  }),
).pipe(Layer.provideMerge(DesktopLifecycle.layer), Layer.provideMerge(desktopWindowLayer));

const desktopUpdatesLayer = DesktopUpdates.layer.pipe(
  Layer.provideMerge(ElectronUpdater.layer),
  Layer.provideMerge(desktopConfigLayer),
);

const desktopUpdateIpcActionsLayer = Layer.effect(
  DesktopUpdateIpcActions,
  Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return DesktopUpdateIpcActions.of({
      getState: updates.getState,
      setChannel: updates.setChannel,
      download: updates.download,
      install: updates.install,
      check: updates.check("web-ui"),
    });
  }),
).pipe(Layer.provideMerge(desktopUpdatesLayer));

const desktopApplicationMenuLayer = DesktopApplicationMenu.layer.pipe(
  Layer.provideMerge(desktopUpdatesLayer),
  Layer.provideMerge(desktopWindowLayer),
);

const desktopBackendDependenciesLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  NetService.layer,
  DesktopBackendConfiguration.layer,
  DesktopBackendEvents.layer.pipe(
    Layer.provide(desktopBackendOutputLogLayer),
    Layer.provide(desktopWindowLayer),
  ),
);

const desktopBackendManagerLayer = DesktopBackendManager.layer.pipe(
  Layer.provide(desktopBackendDependenciesLayer),
);

const desktopBackendRuntimeLayer = desktopBackendManagerLayer.pipe(
  Layer.provideMerge(desktopServerExposureLayer),
);

const desktopRuntimeLayer = Layer.mergeAll(
  desktopLoggerLayer,
  desktopAppIdentityLayer,
  desktopApplicationMenuLayer,
  desktopShellEnvironmentLayer,
  desktopSshRuntimeLayer,
  DesktopLifecycle.layer,
  desktopWindowLayer,
  Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(Electron.ipcMain)),
  desktopServerExposureIpcActionsLayer,
  desktopUpdateIpcActionsLayer,
  DesktopWindowIpcActionsLive.layer,
  DesktopSecretStorage.layer,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(desktopBackendRuntimeLayer),
  Layer.provideMerge(ElectronWindow.layer),
  Layer.provideMerge(ElectronApp.layer),
  Layer.provideMerge(ElectronDialog.layer),
  Layer.provideMerge(ElectronMenu.layer),
  Layer.provideMerge(ElectronProtocol.layer),
  Layer.provideMerge(ElectronShell.layer),
  Layer.provideMerge(ElectronTheme.layer),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(desktopEnvironmentLayer),
  Layer.provideMerge(DesktopShutdown.layer),
  Layer.provideMerge(DesktopRun.layer),
  Layer.provideMerge(DesktopState.layer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
