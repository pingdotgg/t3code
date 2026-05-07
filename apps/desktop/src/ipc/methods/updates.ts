import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../main/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getUpdateState = makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.getState;
    }),
});

export const setUpdateChannel = makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: (channel) =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.setChannel(channel);
    }),
});

export const downloadUpdate = makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.download;
    }),
});

export const installUpdate = makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.install;
    }),
});

export const checkForUpdate = makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.check("web-ui");
    }),
});
