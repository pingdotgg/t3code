import {
  AppleIntentAuthCredential,
  AppleIntentIndexDelta,
  AppleIntentOnscreenContext,
  AppleIntentStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppleIntents from "../../intents/DesktopAppleIntents.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const appleIntentsGetStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: AppleIntentStatus,
  handler: Effect.fn("desktop.ipc.appleIntents.getStatus")(function* () {
    return yield* (yield* DesktopAppleIntents.DesktopAppleIntents).getStatus;
  }),
});

export const appleIntentsSyncIndex = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_SYNC_INDEX_CHANNEL,
  payload: AppleIntentIndexDelta,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleIntents.syncIndex")(function* (delta) {
    yield* (yield* DesktopAppleIntents.DesktopAppleIntents).syncIndex(delta);
  }),
});

export const appleIntentsRemoveEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_REMOVE_ENVIRONMENT_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleIntents.removeEnvironment")(function* (environmentId) {
    yield* (yield* DesktopAppleIntents.DesktopAppleIntents).removeEnvironment(environmentId);
  }),
});

export const appleIntentsClearIndex = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_CLEAR_INDEX_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleIntents.clearIndex")(function* () {
    yield* (yield* DesktopAppleIntents.DesktopAppleIntents).clearIndex;
  }),
});

export const appleIntentsSetOnscreenContext = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_SET_ONSCREEN_CONTEXT_CHANNEL,
  payload: AppleIntentOnscreenContext,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleIntents.setOnscreenContext")(function* (context) {
    yield* (yield* DesktopAppleIntents.DesktopAppleIntents).setOnscreenContext(context);
  }),
});

export const appleIntentsSyncAuthCredentials = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_INTENTS_SYNC_AUTH_CREDENTIALS_CHANNEL,
  payload: Schema.Array(AppleIntentAuthCredential),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appleIntents.syncAuthCredentials")(function* (credentials) {
    yield* (yield* DesktopAppleIntents.DesktopAppleIntents).syncAuthCredentials(credentials);
  }),
});
