import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const TRANSCRIPTION_URL_TTL_MS = 10 * 60_000;
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";

export const TranscriptionService = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});
export type TranscriptionService = typeof TranscriptionService.Type;

export const TranscriptionServices = Schema.Array(TranscriptionService);
export type TranscriptionServices = typeof TranscriptionServices.Type;

export const TranscriptionCreateUrlInput = Schema.Struct({
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(TRANSCRIPTION_MAX_AUDIO_BYTES),
  ),
  locale: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});
export type TranscriptionCreateUrlInput = typeof TranscriptionCreateUrlInput.Type;

export const TranscriptionCreateUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type TranscriptionCreateUrlResult = typeof TranscriptionCreateUrlResult.Type;

export const TranscriptionResponse = Schema.Struct({
  text: Schema.String,
});
export type TranscriptionResponse = typeof TranscriptionResponse.Type;

export class TranscriptionSigningKeyError extends Schema.TaggedErrorClass<TranscriptionSigningKeyError>()(
  "TranscriptionSigningKeyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load the transcription signing key.";
  }
}

export class TranscriptionUnavailableError extends Schema.TaggedErrorClass<TranscriptionUnavailableError>()(
  "TranscriptionUnavailableError",
  {},
) {
  override get message(): string {
    return "No transcription service is configured.";
  }
}
