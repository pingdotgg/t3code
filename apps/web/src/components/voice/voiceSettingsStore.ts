import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export const VOICE_SPEED_MIN = 0.7;
export const VOICE_SPEED_MAX = 1.5;
export const VOICE_SPEED_STEP = 0.05;
export const DEFAULT_VOICE_SPEED = 1;

export const VOICE_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "en", label: "English" },
  { value: "ar-EG", label: "Arabic (Egypt)" },
  { value: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { value: "ar-AE", label: "Arabic (United Arab Emirates)" },
  { value: "bn", label: "Bengali" },
  { value: "zh", label: "Chinese (Simplified)" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "ru", label: "Russian" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "tr", label: "Turkish" },
  { value: "vi", label: "Vietnamese" },
] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGE_OPTIONS)[number]["value"];

interface VoiceSettingsState {
  readonly speed: number;
  readonly language: VoiceLanguage;
  readonly setSpeed: (speed: number) => void;
  readonly setLanguage: (language: VoiceLanguage) => void;
}

export function normalizeVoiceSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_SPEED;
  const clamped = Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, value));
  return Number((Math.round(clamped / VOICE_SPEED_STEP) * VOICE_SPEED_STEP).toFixed(2));
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return VOICE_LANGUAGE_OPTIONS.some((option) => option.value === value);
}

export function voiceLanguageLabel(language: VoiceLanguage): string {
  return VOICE_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;
}

export function createVoiceAudioConfig(
  sampleRate: number,
  settings: Pick<VoiceSettingsState, "speed" | "language">,
) {
  // xAI silently falls back to automatic detection for an unrecognized hint.
  // Using this sentinel also clears a previously selected hint during a live session.
  const languageHint = settings.language === "auto" ? "auto" : settings.language;

  return {
    input: {
      format: { type: "audio/pcm", rate: sampleRate },
      transcription: {
        model: "grok-transcribe",
        language_hint: languageHint,
      },
    },
    output: {
      format: { type: "audio/pcm", rate: sampleRate },
      speed: normalizeVoiceSpeed(settings.speed),
    },
  } as const;
}

export const useVoiceSettingsStore = create<VoiceSettingsState>()(
  persist(
    (set) => ({
      speed: DEFAULT_VOICE_SPEED,
      language: "auto",
      setSpeed: (speed) => set({ speed: normalizeVoiceSpeed(speed) }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: "t3code:voice-settings:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: (state) => ({ speed: state.speed, language: state.language }),
      merge: (persisted, current) => {
        const value = persisted as Partial<VoiceSettingsState> | undefined;
        return {
          ...current,
          speed: normalizeVoiceSpeed(value?.speed ?? DEFAULT_VOICE_SPEED),
          language: isVoiceLanguage(value?.language) ? value.language : "auto",
        };
      },
    },
  ),
);
