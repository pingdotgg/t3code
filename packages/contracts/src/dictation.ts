import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Sample rate every client sends. The server never resamples or decodes containers. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** Matches the client recording cap in `client-runtime/voice-input`. */
export const DICTATION_MAX_SECONDS = 5 * 60;

export const DictationModelId = Schema.Literals(["parakeet-v3", "whisper-turbo", "moonshine-base"]);
export type DictationModelId = typeof DictationModelId.Type;

export const DictationEngine = Schema.Literals(["off", "local"]);
export type DictationEngine = typeof DictationEngine.Type;

/** "auto" lets the model detect the language; otherwise a code from the model's `languageOptions`. */
export const DictationLanguage = TrimmedNonEmptyString;
export type DictationLanguage = typeof DictationLanguage.Type;

export const DictationSettings = Schema.Struct({
  engine: DictationEngine.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  localModel: DictationModelId.pipe(
    Schema.withDecodingDefault(Effect.succeed("parakeet-v3" as const)),
  ),
  language: DictationLanguage.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
});
export type DictationSettings = typeof DictationSettings.Type;

export const DictationSettingsPatch = Schema.Struct({
  engine: Schema.optionalKey(DictationEngine),
  localModel: Schema.optionalKey(DictationModelId),
  language: Schema.optionalKey(DictationLanguage),
});
export type DictationSettingsPatch = typeof DictationSettingsPatch.Type;

/** Install state of one downloadable artifact: the native runtime or a model. */
export const DictationInstallState = Schema.Union([
  Schema.TaggedStruct("not-installed", {}),
  Schema.TaggedStruct("installing", {
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.TaggedStruct("installed", { sizeBytes: Schema.Number }),
  Schema.TaggedStruct("failed", { message: Schema.String }),
]);
export type DictationInstallState = typeof DictationInstallState.Type;

/** Server-pushed dictation state for one environment. */
export const DictationState = Schema.Struct({
  /** False when this platform has no supported runtime build. */
  supported: Schema.Boolean,
  settings: DictationSettings,
  runtime: DictationInstallState,
  models: Schema.Array(
    Schema.Struct({
      id: DictationModelId,
      label: TrimmedNonEmptyString,
      /** Human summary, e.g. "25 European languages". */
      languages: TrimmedNonEmptyString,
      /** Languages this model can be pinned to; empty when it only detects automatically. */
      languageOptions: Schema.Array(
        Schema.Struct({ code: TrimmedNonEmptyString, label: TrimmedNonEmptyString }),
      ),
      /** Short caveat shown next to the model, e.g. that it is slow without a GPU. */
      note: Schema.NullOr(TrimmedNonEmptyString).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
      downloadBytes: Schema.Number,
      install: DictationInstallState,
    }),
  ),
  /** The model currently held in memory, if any. */
  loadedModel: Schema.NullOr(DictationModelId),
  /** True when a client can start a session right now (engine on, runtime and model installed). */
  ready: Schema.Boolean,
});
export type DictationState = typeof DictationState.Type;

export const DictationSessionId = TrimmedNonEmptyString.pipe(Schema.brand("DictationSessionId"));
export type DictationSessionId = typeof DictationSessionId.Type;

/** Starts or retries installation of the active model; returns before its download completes. */
export const DictationInstallInput = Schema.Struct({ model: DictationModelId });
export type DictationInstallInput = typeof DictationInstallInput.Type;

/** Removes an inactive model. The selected model is retained while the engine is on. */
export const DictationRemoveInput = Schema.Struct({ model: DictationModelId });
export type DictationRemoveInput = typeof DictationRemoveInput.Type;

export const DictationStartResult = Schema.Struct({ sessionId: DictationSessionId });
export type DictationStartResult = typeof DictationStartResult.Type;

export const DictationAppendInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** Zero-based chunk index. The server orders chunks by it, so concurrent delivery is safe. */
  seq: NonNegativeInt,
  /** Base64 of little-endian int16 mono PCM at `DICTATION_SAMPLE_RATE`. */
  pcm: Schema.String,
});
export type DictationAppendInput = typeof DictationAppendInput.Type;

export const DictationFinishInput = Schema.Struct({
  sessionId: DictationSessionId,
  /** Total chunks sent, so the server can wait for stragglers before decoding. */
  chunkCount: NonNegativeInt,
});
export type DictationFinishInput = typeof DictationFinishInput.Type;

export const DictationFinishResult = Schema.Struct({
  text: Schema.String,
  /** BCP 47 tag the transcript is in, used for insertion spacing. */
  locale: Schema.String,
});
export type DictationFinishResult = typeof DictationFinishResult.Type;

export const DictationCancelInput = Schema.Struct({ sessionId: DictationSessionId });
export type DictationCancelInput = typeof DictationCancelInput.Type;

export const DictationErrorReason = Schema.Literals([
  "unsupported-platform",
  "disabled",
  "not-installed",
  "install-failed",
  "load-failed",
  "unknown-session",
  "too-long",
  "transcription-failed",
]);
export type DictationErrorReason = typeof DictationErrorReason.Type;

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: DictationErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
