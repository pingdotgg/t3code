import {
  DesktopChromeExtensionInstallResultSchema,
  DesktopComputerUsePermissionsStateSchema,
  DesktopComputerUsePrivacyPaneSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  openComputerUsePrivacySettings as openPrivacySettings,
  readComputerUsePermissions,
} from "../../computerUse/permissions.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { installChromeExtensionNow } from "../../computerUse/chromeExtensionSetup.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getComputerUsePermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_COMPUTER_USE_PERMISSIONS_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopComputerUsePermissionsStateSchema,
  handler: Effect.fn("desktop.ipc.computerUse.getComputerUsePermissions")(function* () {
    return readComputerUsePermissions();
  }),
});

export const openComputerUsePrivacySettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_COMPUTER_USE_PRIVACY_SETTINGS_CHANNEL,
  payload: DesktopComputerUsePrivacyPaneSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.computerUse.openComputerUsePrivacySettings")(function* (pane) {
    return yield* Effect.promise(() => openPrivacySettings(pane));
  }),
});

export const installChromeExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_CHROME_EXTENSION_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopChromeExtensionInstallResultSchema,
  handler: Effect.fn("desktop.ipc.computerUse.installChromeExtension")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() => installChromeExtensionNow(environment.stateDir));
  }),
});
