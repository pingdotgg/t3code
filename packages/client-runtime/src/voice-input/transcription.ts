import * as Schema from "effect/Schema";

/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

export type LiveVoiceOptions = VoiceTranscriptionOptions & {
  /** The complete transcript so far, including revisions to interim words. */
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
};

export type LiveVoiceSession = {
  /** Resolves with the final transcript once capture and recognition have stopped. */
  readonly stop: () => Promise<string>;
  readonly cancel: () => Promise<void>;
  readonly getStatus: () => {
    readonly durationMillis: number;
    readonly metering: number | undefined;
  } | null;
};

export type VoiceStreamingSession = {
  readonly finish: (options: VoiceTranscriptionOptions) => Promise<string>;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  /** Live capture streams words while recording; the controller owns the microphone otherwise. */
  readonly startStreaming?: (options: LiveVoiceOptions) => Promise<LiveVoiceSession>;
  /** Prepares record-then-transcribe capture when live capture cannot start. */
  readonly prepareFileFallback?: (
    options: VoiceTranscriptionOptions,
  ) => Promise<PreparedVoiceTranscription>;
  /**
   * Runs alongside capture once recording starts. Resolves with the transcript when it
   * transcribed live, or null when `transcribe` still runs after the recording stops.
   * A rejection stops the recording.
   */
  readonly start?: (uri: string, options: VoiceTranscriptionOptions) => Promise<string | null>;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
  /** Present when audio streams during capture; `finish` then replaces `transcribe`. */
  readonly streaming?: VoiceStreamingSession;
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
