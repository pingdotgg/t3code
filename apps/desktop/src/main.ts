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
import * as DesktopSshEnvironment from "./main/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./main/DesktopSshPasswordPrompts.ts";
import * as DesktopSshRemoteApi from "./main/DesktopSshRemoteApi.ts";
import * as DesktopState from "./main/DesktopState.ts";
import * as DesktopUpdates from "./main/DesktopUpdates.ts";
import * as DesktopWindow from "./main/DesktopWindow.ts";
import * as DesktopWindowIpcActions from "./main/DesktopWindowIpcActions.ts";

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    return DesktopEnvironment.layer({
      dirname: __dirname,
      cwd: process.cwd(),
      platform: process.platform,
      processArch: process.arch,
      ...metadata,
    });
  }),
).pipe(Layer.provideMerge(DesktopConfig.layer));

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

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  DesktopSecretStorage.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  Layer.succeed(DesktopIpc.DesktopIpc, DesktopIpc.make(Electron.ipcMain)),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopRun.layer,
  DesktopState.layer,
  DesktopLifecycle.layerShutdown,
  DesktopSettingsState.layer,
  DesktopAssets.layer,
  DesktopLoggerLive,
  DesktopBackendOutputLogLive,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopSshLayer = Layer.mergeAll(desktopSshEnvironmentLayer, DesktopSshRemoteApi.layer).pipe(
  Layer.provideMerge(DesktopSshPasswordPrompts.layer()),
);

const desktopServerExposureLayer = DesktopServerExposure.layer.pipe(
  Layer.provideMerge(DesktopServerExposure.networkInterfacesLayer),
  Layer.provideMerge(desktopFoundationLayer),
);

const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopServerExposureLayer));

const desktopBackendLayer = DesktopBackendManager.layer.pipe(
  Layer.provideMerge(DesktopAppIdentity.layer),
  Layer.provideMerge(DesktopBackendConfiguration.layer),
  Layer.provideMerge(DesktopBackendEvents.layer),
  Layer.provideMerge(desktopWindowLayer),
);

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopShellEnvironment.layer,
  desktopSshLayer,
  DesktopWindowIpcActions.layer,
).pipe(Layer.provideMerge(DesktopUpdates.layer), Layer.provideMerge(desktopBackendLayer));

const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(EffectPath.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
