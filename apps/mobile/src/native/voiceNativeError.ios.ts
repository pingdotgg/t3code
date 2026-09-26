import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

export function getNativeVoiceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function mapNativeVoiceError(
  error: unknown,
  phase: "preparation" | "transcription",
): unknown {
  if (error instanceof VoiceTranscriptionError) return error;

  switch (getNativeVoiceErrorCode(error)) {
    case "ERR_VOICE_UNAVAILABLE":
      return new VoiceTranscriptionError(
        "unavailable",
        "Live voice transcription is unavailable.",
        { cause: error },
      );
    case "ERR_VOICE_BUSY":
      return new VoiceTranscriptionError(
        phase === "preparation" ? "preparation-failed" : "transcription-failed",
        "Another live voice transcription is already active.",
        { cause: error },
      );
    case "ERR_VOICE_AUDIO_FORMAT":
      return new VoiceTranscriptionError(
        phase === "preparation" ? "preparation-failed" : "transcription-failed",
        "Live voice transcription could not configure audio capture.",
        { cause: error },
      );
    default:
      return error;
  }
}
