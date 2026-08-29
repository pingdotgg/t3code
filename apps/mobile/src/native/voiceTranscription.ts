import { VoiceTranscriptionError } from "./voiceTranscription.types";

export { VoiceTranscriptionError } from "./voiceTranscription.types";
export type { VoiceTranscriptionErrorCode } from "./voiceTranscription.types";

function unavailableError(): VoiceTranscriptionError {
  return new VoiceTranscriptionError(
    "unavailable",
    "Voice transcription is not available on this platform.",
  );
}

export function isVoiceTranscriptionAvailable(): boolean {
  return false;
}

export async function prepareVoiceTranscription(): Promise<string> {
  throw unavailableError();
}

export async function transcribeVoiceRecording(_uri: string, _locale: string): Promise<string> {
  throw unavailableError();
}
