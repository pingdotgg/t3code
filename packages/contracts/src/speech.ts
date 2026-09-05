import * as Schema from "effect/Schema";
export const EnvironmentSpeechState = Schema.Literals(["missing-model", "ready", "transcribing"]);
export type EnvironmentSpeechState = typeof EnvironmentSpeechState.Type;

export const EnvironmentSpeechStatus = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.String,
  }),
  Schema.Struct({
    supported: Schema.Literal(true),
    state: EnvironmentSpeechState,
    model: Schema.String,
  }),
]);
export type EnvironmentSpeechStatus = typeof EnvironmentSpeechStatus.Type;

export const EnvironmentSpeechTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type EnvironmentSpeechTranscriptionResult = typeof EnvironmentSpeechTranscriptionResult.Type;
