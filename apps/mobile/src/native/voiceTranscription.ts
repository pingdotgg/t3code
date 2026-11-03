import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export async function getLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  return null;
}

export function getVoiceTranscriberForLocale(_locale: string): VoiceTranscriber | null {
  return null;
}
