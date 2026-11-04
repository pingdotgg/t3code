/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

export type VoiceStreamingOptions = VoiceTranscriptionOptions & {
  /** The complete transcript so far, including revisions to interim words. */
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
};

export type VoiceStreamingSession = {
  /** Resolves with the final transcript once capture and recognition have stopped. */
  readonly stop: () => Promise<string>;
  readonly cancel: () => Promise<void>;
  readonly getStatus: () => {
    readonly durationMillis: number;
    readonly metering: number | undefined;
  } | null;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  /** Live capture streams words while recording; the controller owns the microphone otherwise. */
  readonly startStreaming?: (options: VoiceStreamingOptions) => Promise<VoiceStreamingSession>;
  /** Prepares record-then-transcribe capture when live capture cannot start. */
  readonly prepareFileFallback?: (
    options: VoiceTranscriptionOptions,
  ) => Promise<PreparedVoiceTranscription>;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

export type VoiceTranscriptionErrorCode =
  | "unavailable"
  | "unsupported-locale"
  | "preparation-failed"
  | "transcription-failed"
  | "cancelled";

export class VoiceTranscriptionError extends Error {
  readonly code: VoiceTranscriptionErrorCode;

  constructor(code: VoiceTranscriptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceTranscriptionError";
    this.code = code;
  }
}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
}
