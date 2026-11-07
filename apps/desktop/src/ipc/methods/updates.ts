import { DesktopUpdateCommandResponse } from "@t3tools/contracts";
import * as DesktopUpdateCommand from "../../updates/DesktopUpdateCommand.ts";
import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: Schema.Struct({
    channel: DesktopUpdateChannelSchema,
    minimumVersion: Schema.optional(Schema.String),
  }),
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* ({ channel, minimumVersion }) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel, { minimumVersion });
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  /** A version installs only that downloaded build, never one that replaced it. */
  payload: Schema.UndefinedOr(Schema.String),
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* (expectedVersion) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    if (expectedVersion === undefined) return yield* updates.install;
    const { accepted, completed, state } = yield* updates.installPrepared(expectedVersion);
    return { accepted, completed, state };
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

export const updateCommandReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_COMMAND_READY_CHANNEL,
  payload: Schema.Struct({ ready: Schema.Boolean, rendererId: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updateCommand.ready")(function* ({ ready, rendererId }) {
    yield* (yield* DesktopUpdateCommand.DesktopUpdateCommand).setReady(ready, rendererId);
  }),
});
export const updateCommandComplete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_COMMAND_COMPLETE_CHANNEL,
  payload: DesktopUpdateCommandResponse,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updateCommand.complete")(function* (response) {
    return yield* (yield* DesktopUpdateCommand.DesktopUpdateCommand).complete(response);
  }),
});
export const updateCommandRun = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_COMMAND_RUN_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCommandResponse,
  handler: Effect.fn("desktop.ipc.updateCommand.run")(function* () {
    return yield* (yield* DesktopUpdateCommand.DesktopUpdateCommand).request({
      version: 1,
      type: "update",
      requestId: "desktop-update",
    });
  }),
});
export const updateCommandReserve = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_COMMAND_RESERVE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.updateCommand.reserve")(function* () {
    return yield* (yield* DesktopUpdateCommand.DesktopUpdateCommand).reserve;
  }),
});
export const updateCommandFinish = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_COMMAND_FINISH_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updateCommand.finish")(function* (reservation) {
    yield* (yield* DesktopUpdateCommand.DesktopUpdateCommand).finish(reservation);
  }),
});
