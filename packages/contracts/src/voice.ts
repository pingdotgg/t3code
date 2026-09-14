import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const VoiceSdp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));
const VoiceSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const VoiceStartInput = Schema.Struct({ threadId: ThreadId, sdp: VoiceSdp });
export type VoiceStartInput = typeof VoiceStartInput.Type;

export const VoiceStartResult = Schema.Struct({ sessionId: VoiceSessionId, sdp: VoiceSdp });
export type VoiceStartResult = typeof VoiceStartResult.Type;

export const VoiceStopInput = Schema.Struct({ sessionId: VoiceSessionId });
export type VoiceStopInput = typeof VoiceStopInput.Type;

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  message: Schema.String,
}) {}
