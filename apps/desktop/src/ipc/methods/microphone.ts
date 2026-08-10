import { DesktopMicrophoneAccessStatusSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronSystemPreferences from "../../electron/ElectronSystemPreferences.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getMicrophoneAccessStatus = makeIpcMethod({
  channel: IpcChannels.GET_MICROPHONE_ACCESS_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopMicrophoneAccessStatusSchema,
  handler: Effect.fn("desktop.ipc.microphone.getAccessStatus")(function* () {
    const systemPreferences = yield* ElectronSystemPreferences.ElectronSystemPreferences;
    return yield* systemPreferences.getMicrophoneAccessStatus;
  }),
});

export const requestMicrophoneAccess = makeIpcMethod({
  channel: IpcChannels.REQUEST_MICROPHONE_ACCESS_CHANNEL,
  payload: Schema.Void,
  result: DesktopMicrophoneAccessStatusSchema,
  handler: Effect.fn("desktop.ipc.microphone.requestAccess")(function* () {
    const systemPreferences = yield* ElectronSystemPreferences.ElectronSystemPreferences;
    return yield* systemPreferences.requestMicrophoneAccess;
  }),
});
