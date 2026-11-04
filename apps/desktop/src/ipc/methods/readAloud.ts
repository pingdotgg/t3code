import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { listEdgeTtsVoices, synthesizeWithEdgeTts } from "../../readAloud/EdgeTts.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SynthesizeResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), audioBase64: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

export const synthesize = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_ALOUD_SYNTHESIZE_CHANNEL,
  payload: Schema.Struct({
    text: Schema.String,
    voice: Schema.String,
    rate: Schema.optionalKey(Schema.String),
  }),
  result: SynthesizeResult,
  handler: Effect.fn("desktop.ipc.readAloud.synthesize")(function* (input) {
    return yield* Effect.promise(() => synthesizeWithEdgeTts(input));
  }),
});

export const listVoices = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_ALOUD_LIST_VOICES_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Array(
    Schema.Struct({
      shortName: Schema.String,
      gender: Schema.String,
      personalities: Schema.String,
    }),
  ),
  handler: Effect.fn("desktop.ipc.readAloud.listVoices")(function* () {
    return yield* Effect.promise(() => listEdgeTtsVoices());
  }),
});
