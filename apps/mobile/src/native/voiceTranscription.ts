import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export type LocalVoiceEngine =
  | { readonly kind: "apple" }
  | {
      readonly kind: "google";
      readonly advanced: boolean;
      readonly downloaded: boolean;
      /** Display name in the device language, from Android: Hermes lacks Intl.DisplayNames. */
      readonly language: string;
    };

export type LocalVoiceTranscriber = VoiceTranscriber & { readonly engine: LocalVoiceEngine };

export async function getLocalVoiceTranscriber(): Promise<LocalVoiceTranscriber | null> {
  return null;
}
