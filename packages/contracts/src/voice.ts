import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Bound abandoned sessions even when the client disappears without stopping.
export const VOICE_SESSION_LIMIT_SECONDS = 360;
export const VoiceStartRequest = Schema.Struct({
  instanceId: ProviderInstanceId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export const VoiceStartResponse = Schema.Struct({ sessionId: Schema.String, sdp: Schema.String });
export const VoiceStopRequest = Schema.Struct({ sessionId: Schema.String });
export const VoiceAvailabilityQuery = Schema.Struct({ instanceId: ProviderInstanceId });
export const VoiceAvailabilityResponse = Schema.Struct({ codexVoiceAvailable: Schema.Boolean });

export const VoiceFinishRequest = Schema.Struct({
  sessionId: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(30_000)),
});
export const VoiceFinishResponse = Schema.Struct({ text: Schema.String });

export const VoicePolishStyle = Schema.Literals(["cleanup", "concise", "formal", "casual"]);
export type VoicePolishStyle = typeof VoicePolishStyle.Type;
export const VoicePolishRequest = Schema.Struct({
  instanceId: ProviderInstanceId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000)),
  style: VoicePolishStyle,
});

export const DictationReplacement = Schema.Struct({
  kind: Schema.Literals(["word", "snippet"]),
  phrase: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  replacement: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4000),
    Schema.isPattern(/\S/u),
  ),
});
export type DictationReplacement = typeof DictationReplacement.Type;
export const DictationSettings = Schema.Struct({
  autoPolish: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  spokenCommands: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  removeFillers: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  replacements: Schema.Array(DictationReplacement)
    .check(Schema.isMaxLength(200))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type DictationSettings = typeof DictationSettings.Type;
export const DEFAULT_DICTATION_SETTINGS = Schema.decodeSync(DictationSettings)({});
