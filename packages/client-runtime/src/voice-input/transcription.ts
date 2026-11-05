import * as Schema from "effect/Schema";

/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

const VoiceTranscriptionErrorCode = Schema.Literals([
  "unavailable",
  "unsupported-locale",
  "preparation-failed",
  "transcription-failed",
  "cancelled",
]);
export type VoiceTranscriptionErrorCode = typeof VoiceTranscriptionErrorCode.Type;

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    code: VoiceTranscriptionErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError({
      code: "cancelled",
      message: "Voice transcription was cancelled.",
    });
  }
}
