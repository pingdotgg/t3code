import {
  DesktopMicrophoneSettingsSchema,
  DesktopSpeechPreparationSchema,
  DesktopSpeechStatusSchema,
} from "@t3tools/contracts";
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

export const getSpeechMicrophones = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_GET_MICROPHONES_CHANNEL,
  payload: Schema.Void,
  result: DesktopMicrophoneSettingsSchema,
  handler: Effect.fn("desktop.ipc.speech.getMicrophones")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.getMicrophones;
  }),
});

export const setSpeechMicrophone = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_SET_MICROPHONE_CHANNEL,
  payload: Schema.String,
  result: DesktopMicrophoneSettingsSchema,
  handler: Effect.fn("desktop.ipc.speech.setMicrophone")(function* (deviceName) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.setMicrophone(deviceName);
  }),
});

export const prepareSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_PREPARE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechPreparationSchema,
  handler: Effect.fn("desktop.ipc.speech.prepare")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.prepare;
  }),
});

export const cancelSpeechPreparation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_PREPARATION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speech.cancelPreparation")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    yield* speech.cancelPreparation;
  }),
});

export const startSpeechRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_START_RECORDING_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speech.startRecording")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    yield* speech.startRecording;
  }),
});

export const stopSpeechRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_STOP_RECORDING_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.speech.stopRecording")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.stopRecording;
  }),
});

export const cancelSpeechRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_RECORDING_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speech.cancelRecording")(function* () {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    yield* speech.cancelRecording;
  }),
});

export const transcribeSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_TRANSCRIBE_CHANNEL,
  payload: Schema.String,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.speech.transcribe")(function* (uri) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    return yield* speech.transcribe(uri);
  }),
});

export const deleteSpeechRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_DELETE_RECORDING_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speech.deleteRecording")(function* (uri) {
    const speech = yield* DesktopSpeech.DesktopSpeech;
    yield* speech.deleteRecording(uri);
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
