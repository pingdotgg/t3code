import * as Schema from "effect/Schema";

export const SpeechModelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export type SpeechModelId = typeof SpeechModelId.Type;

export const EnvironmentSpeechModelState = Schema.Literals([
  "downloadable",
  "downloading",
  "verifying",
  "installed",
]);
export type EnvironmentSpeechModelState = typeof EnvironmentSpeechModelState.Type;

export const EnvironmentSpeechModel = Schema.Struct({
  id: SpeechModelId,
  name: Schema.String,
  description: Schema.String,
  size: Schema.Finite,
  languages: Schema.Array(Schema.String),
  accuracy: Schema.Finite,
  speed: Schema.Finite,
  recommended: Schema.Boolean,
  supportsStreaming: Schema.Boolean,
  active: Schema.Boolean,
  state: EnvironmentSpeechModelState,
  downloaded: Schema.optionalKey(Schema.Finite),
});
export type EnvironmentSpeechModel = typeof EnvironmentSpeechModel.Type;

export const EnvironmentSpeechModels = Schema.Struct({
  models: Schema.Array(EnvironmentSpeechModel),
});
export type EnvironmentSpeechModels = typeof EnvironmentSpeechModels.Type;

export const EnvironmentSpeechModelRequest = Schema.Struct({ modelId: SpeechModelId });
export type EnvironmentSpeechModelRequest = typeof EnvironmentSpeechModelRequest.Type;

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
    modelId: SpeechModelId,
    model: Schema.String,
    size: Schema.Finite,
    supportsStreaming: Schema.Boolean,
  }),
]);
export type EnvironmentSpeechStatus = typeof EnvironmentSpeechStatus.Type;

export const EnvironmentSpeechTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type EnvironmentSpeechTranscriptionResult = typeof EnvironmentSpeechTranscriptionResult.Type;

export const SPEECH_STREAM_PATH = "/ws/voice";
const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_STREAM_MAX_CHUNK_BYTES = SPEECH_SAMPLE_RATE * 4;
export const SPEECH_STREAM_MAX_QUEUED_BYTES = SPEECH_SAMPLE_RATE * 4 * 5;

export const SpeechStreamCommand = Schema.Struct({ type: Schema.Literal("finish") });

export const SpeechStreamText = Schema.Struct({
  committed: Schema.String,
  tentative: Schema.String,
});
export type SpeechStreamText = typeof SpeechStreamText.Type;

export const SpeechStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({
    type: Schema.Literal("update"),
    revision: Schema.Int,
    text: Schema.NullOr(SpeechStreamText),
  }),
  Schema.Struct({ type: Schema.Literal("finished"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type SpeechStreamEvent = typeof SpeechStreamEvent.Type;
