import {
  DesktopAppleSpeechResultSchema,
  DesktopAppleSpeechTranscribeInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AppleSpeech from "../../speech/AppleSpeech.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const appleSpeechAvailable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_AVAILABLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appleSpeech.available")(function* () {
    return yield* (yield* AppleSpeech.AppleSpeech).isAvailable;
  }),
});

export const appleSpeechPrepare = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_PREPARE_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(64)),
  result: DesktopAppleSpeechResultSchema,
  handler: Effect.fn("desktop.ipc.appleSpeech.prepare")(function* (locale) {
    return yield* (yield* AppleSpeech.AppleSpeech).prepare(locale);
  }),
});

export const appleSpeechTranscribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLE_SPEECH_TRANSCRIBE_CHANNEL,
  payload: DesktopAppleSpeechTranscribeInputSchema,
  result: DesktopAppleSpeechResultSchema,
  handler: Effect.fn("desktop.ipc.appleSpeech.transcribe")(function* ({ locale, pcm }) {
    return yield* (yield* AppleSpeech.AppleSpeech).transcribe(locale, pcm);
  }),
});
