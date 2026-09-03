import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import {
  clearConnectionCatalog,
  getConnectionCatalog,
  setConnectionCatalog,
} from "./methods/connectionCatalog.ts";
import {
  getAdvertisedEndpoints,
  getServerExposureState,
  setServerExposureMode,
  setTailscaleServeEnabled,
} from "./methods/serverExposure.ts";
import {
  bootstrapSshBearerSession,
  disconnectSshEnvironment,
  discoverSshHosts,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
  fetchSshSessionState,
  issueSshWebSocketTicket,
  resolveSshHost,
  resolveSshPasswordPrompt,
} from "./methods/sshEnvironment.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setUpdateChannel,
} from "./methods/updates.ts";
import {
  getAppBranding,
  getLocalEnvironmentBootstraps,
  getLocalEnvironmentBearerToken,
  getSystemLocale,
  getWindowFullscreenState,
  openExternal,
  probeRemoteEditors,
  pickFolder,
  pickProjectFavicon,
  pickThemeFiles,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";
import * as PreviewIpc from "./methods/preview.ts";
import * as AppActivationIpc from "./methods/appActivation.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./methods/wsl.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* PreviewIpc.installPreviewEventForwarding();

  yield* ipc.handle(AppActivationIpc.setReady);
  yield* ipc.handle(AppActivationIpc.complete);

  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getLocalEnvironmentBootstraps);
  yield* ipc.handle(getLocalEnvironmentBearerToken);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(setConnectionCatalog);
  yield* ipc.handle(clearConnectionCatalog);

  yield* ipc.handle(discoverSshHosts);
  yield* ipc.handle(resolveSshHost);
  yield* ipc.handle(ensureSshEnvironment);
  yield* ipc.handle(disconnectSshEnvironment);
  yield* ipc.handle(fetchSshEnvironmentDescriptor);
  yield* ipc.handle(bootstrapSshBearerSession);
  yield* ipc.handle(fetchSshSessionState);
  yield* ipc.handle(issueSshWebSocketTicket);
  yield* ipc.handle(resolveSshPasswordPrompt);

  yield* ipc.handle(getServerExposureState);
  yield* ipc.handle(setServerExposureMode);
  yield* ipc.handle(setTailscaleServeEnabled);
  yield* ipc.handle(getAdvertisedEndpoints);

  yield* ipc.handle(getWslState);
  yield* ipc.handle(setWslBackendEnabled);
  yield* ipc.handle(setWslDistro);
  yield* ipc.handle(setWslOnly);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(pickProjectFavicon);
  yield* ipc.handle(pickThemeFiles);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(probeRemoteEditors);
  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  for (const previewMethod of PreviewIpc.methods) {
    yield* ipc.handle(previewMethod);
  }
});
