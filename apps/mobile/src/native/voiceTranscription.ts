import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import type { DictationLanguage } from "./voiceTranscription.types";

export function getLocalVoiceTranscriber(_preferredLocale?: string): VoiceTranscriber | null {
  return null;
}

export function getDictationLanguages(): Promise<ReadonlyArray<DictationLanguage>> {
  return Promise.resolve([]);
}
