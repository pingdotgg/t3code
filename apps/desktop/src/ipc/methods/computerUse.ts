import {
  DesktopComputerUsePermissionsStateSchema,
  DesktopComputerUsePrivacyPaneSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  openComputerUsePrivacySettings as openPrivacySettings,
  readComputerUsePermissions,
} from "../../computerUse/permissions.ts";
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
