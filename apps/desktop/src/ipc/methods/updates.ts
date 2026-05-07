import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../main/DesktopUpdates.ts";
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_SET_CHANNEL_CHANNEL,
} from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getUpdateState = makeIpcMethod({
  channel: UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.getState;
    }),
});

export const setUpdateChannel = makeIpcMethod({
  channel: UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: (channel) =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.setChannel(channel);
    }),
});

export const downloadUpdate = makeIpcMethod({
  channel: UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.download;
    }),
});

export const installUpdate = makeIpcMethod({
  channel: UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.install;
    }),
});

export const checkForUpdate = makeIpcMethod({
  channel: UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: () =>
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      return yield* updates.check("web-ui");
    }),
});
