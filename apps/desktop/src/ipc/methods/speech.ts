import { DesktopSpeechStatusSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSpeech from "../../speech/DesktopSpeech.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installSpeechEventForwarding = Effect.fn("desktop.ipc.speech.events")(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const speech = yield* DesktopSpeech.DesktopSpeech;
  yield* speech.subscribe((event) => windows.sendAll(IpcChannels.SPEECH_EVENT_CHANNEL, event));
});

export const getSpeechStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: Effect.fn("desktop.ipc.speech.getStatus")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.getStatus;
  }),
});

export const startSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_START_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: Effect.fn("desktop.ipc.speech.start")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.start;
  }),
});

export const stopSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_STOP_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: Effect.fn("desktop.ipc.speech.stop")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.stop;
  }),
});

export const cancelSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: Effect.fn("desktop.ipc.speech.cancel")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.cancel;
  }),
});

export const removeSpeechModelMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_REMOVE_MODEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: Effect.fn("desktop.ipc.speech.removeModel")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.removeModel;
  }),
});
