// @effect-diagnostics nodeBuiltinImport:off - platform tuple and Electron app paths define native availability.
import { DesktopSpeechStatusSchema, type DesktopSpeechEvent } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { app } from "electron";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { DesktopMicrophoneCapture } from "../../speech/DesktopMicrophoneCapture.ts";
import { DesktopSpeechController } from "../../speech/DesktopSpeechController.ts";
import { DesktopTranscriptionBackend } from "../../speech/DesktopTranscriptionBackend.ts";
import {
  SPEECH_MODEL,
  downloadVerifiedModel,
  isSpeechModelReady,
  removeSpeechModel,
  speechModelPath,
} from "../../speech/speechModel.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

let controller: DesktopSpeechController | undefined;
let emitEvent: (event: DesktopSpeechEvent) => void = () => undefined;
let availability: { supported: boolean; reason?: string } = {
  supported: false,
  reason: "voice input is still starting",
};

function support(platform: string, architecture: string): { supported: boolean; reason?: string } {
  if (platform === "win32" && architecture === "arm64") {
    return { supported: false, reason: "voice input is not available on Windows arm64 yet" };
  }
  const tuple = `${platform}-${architecture}`;
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "linux-x64",
    "linux-arm64",
  ]).has(tuple);
  return supported
    ? { supported: true }
    : { supported: false, reason: `voice input is not available on ${tuple}` };
}

function speechModelDirectory(): string {
  return NodePath.join(app.getPath("userData"), "speech", "models");
}

function getController(): DesktopSpeechController {
  if (controller) return controller;
  const directory = speechModelDirectory();
  controller = new DesktopSpeechController({
    supported: availability.supported,
    ...(availability.reason ? { unsupportedReason: availability.reason } : {}),
    modelPath: speechModelPath(directory),
    modelReady: () => isSpeechModelReady(directory),
    downloadModel: (onProgress) =>
      downloadVerifiedModel({
        directory,
        filename: SPEECH_MODEL.filename,
        url: SPEECH_MODEL.url,
        size: SPEECH_MODEL.size,
        sha256: SPEECH_MODEL.sha256,
        onProgress,
      }),
    removeModel: () => removeSpeechModel(directory),
    createCapture: () =>
      new DesktopMicrophoneCapture((level, elapsedMs) =>
        emitEvent({ type: "level", level, elapsedMs }),
      ),
    createBackend: (modelPath) => new DesktopTranscriptionBackend(modelPath),
    emit: (event) => emitEvent(event),
  });
  return controller;
}

function invoke(
  operation: (value: DesktopSpeechController) => Promise<unknown>,
): Effect.Effect<unknown> {
  return Effect.promise(() => operation(getController()));
}

export const installSpeechEventForwarding = Effect.fn("desktop.ipc.speech.events")(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  availability = support(platform, architecture);
  emitEvent = (event) => {
    Effect.runFork(windows.sendAll(IpcChannels.SPEECH_EVENT_CHANNEL, event));
  };
});

export const getSpeechStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: () => invoke((value) => value.getStatus()),
});

export const startSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_START_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: () => invoke((value) => value.start()),
});

export const stopSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_STOP_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: () => invoke((value) => value.stop()),
});

export const cancelSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: () => invoke((value) => value.cancel()),
});

export const removeSpeechModelMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_REMOVE_MODEL_CHANNEL,
  payload: Schema.Void,
  result: DesktopSpeechStatusSchema,
  handler: () => invoke((value) => value.removeModel()),
});
