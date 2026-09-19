import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const SpeechModelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export type SpeechModelId = typeof SpeechModelId.Type;

export const SpeechCustomWord = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50));
export const SpeechCustomWords = Schema.Array(SpeechCustomWord).check(Schema.isMaxLength(100));
export type SpeechCustomWords = typeof SpeechCustomWords.Type;

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
    customWords: SpeechCustomWords.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    removeFillerWords: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  }),
]);
export type EnvironmentSpeechStatus = typeof EnvironmentSpeechStatus.Type;

export const EnvironmentSpeechTranscriptionResult = Schema.Struct({
  text: Schema.String,
});

export const EnvironmentSpeechCustomWordsRequest = Schema.Struct({ words: SpeechCustomWords });
export const EnvironmentSpeechFillerWordsRequest = Schema.Struct({ enabled: Schema.Boolean });
export const SpeechPostProcessingPrompt = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
});
export type SpeechPostProcessingPrompt = typeof SpeechPostProcessingPrompt.Type;
export const SpeechPostProcessingPrompts = Schema.Array(SpeechPostProcessingPrompt).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
);
export const EnvironmentSpeechPostProcessingRequest = Schema.Struct({
  transcript: Schema.String.check(Schema.isMaxLength(100_000)),
});
export const EnvironmentSpeechPostProcessingResult = Schema.Struct({ text: Schema.String });
export type EnvironmentSpeechTranscriptionResult = typeof EnvironmentSpeechTranscriptionResult.Type;

export const SPEECH_STREAM_PATH = "/ws/voice";
const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_STREAM_MAX_CHUNK_BYTES = SPEECH_SAMPLE_RATE * 4;
export const SPEECH_STREAM_MAX_QUEUED_BYTES = SPEECH_SAMPLE_RATE * 4 * 5 * 60;

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
