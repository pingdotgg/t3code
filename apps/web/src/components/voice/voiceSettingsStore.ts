import type { VoiceRealtimeModel } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export const VOICE_SPEED_MIN = 0.25;
export const VOICE_SPEED_MAX = 1.5;
export const VOICE_SPEED_STEP = 0.05;
export const DEFAULT_VOICE_SPEED = 1;

export const VOICE_MODEL_OPTIONS = [
  {
    value: "gpt-realtime-2.1-mini",
    label: "GPT-Realtime-2.1 mini",
    description: "Recommended · faster and lower cost",
  },
  {
    value: "gpt-realtime-2.1",
    label: "GPT-Realtime-2.1",
    description: "Most capable · higher cost",
  },
] as const satisfies ReadonlyArray<{
  readonly value: VoiceRealtimeModel;
  readonly label: string;
  readonly description: string;
}>;

export const VOICE_OPTIONS = [
  { value: "marin", label: "Marin (recommended)" },
  { value: "cedar", label: "Cedar (recommended)" },
  { value: "alloy", label: "Alloy" },
  { value: "ash", label: "Ash" },
  { value: "ballad", label: "Ballad" },
  { value: "coral", label: "Coral" },
  { value: "echo", label: "Echo" },
  { value: "sage", label: "Sage" },
  { value: "shimmer", label: "Shimmer" },
  { value: "verse", label: "Verse" },
] as const;

export const VOICE_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "bn", label: "Bengali" },
  { value: "zh", label: "Chinese" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "pt", label: "Portuguese" },
  { value: "ru", label: "Russian" },
  { value: "es", label: "Spanish" },
  { value: "tr", label: "Turkish" },
  { value: "vi", label: "Vietnamese" },
] as const;

export const VOICE_REASONING_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low (recommended)" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
] as const;

export const VOICE_TURN_EAGERNESS_OPTIONS = [
  { value: "low", label: "Patient" },
  { value: "auto", label: "Balanced (recommended)" },
  { value: "high", label: "Quick" },
] as const;

export const VOICE_NOISE_REDUCTION_OPTIONS = [
  { value: "far_field", label: "Laptop / room mic (recommended)" },
  { value: "near_field", label: "Headset / close mic" },
  { value: "off", label: "Off" },
] as const;

export type VoiceName = (typeof VOICE_OPTIONS)[number]["value"];
export type VoiceLanguage = (typeof VOICE_LANGUAGE_OPTIONS)[number]["value"];
export type VoiceReasoningEffort = (typeof VOICE_REASONING_OPTIONS)[number]["value"];
export type VoiceTurnEagerness = (typeof VOICE_TURN_EAGERNESS_OPTIONS)[number]["value"];
export type VoiceNoiseReduction = (typeof VOICE_NOISE_REDUCTION_OPTIONS)[number]["value"];

export interface VoiceSettingsState {
  readonly model: VoiceRealtimeModel;
  readonly voice: VoiceName;
  readonly speed: number;
  readonly language: VoiceLanguage;
  readonly reasoningEffort: VoiceReasoningEffort;
  readonly turnEagerness: VoiceTurnEagerness;
  readonly noiseReduction: VoiceNoiseReduction;
  readonly setModel: (model: VoiceRealtimeModel) => void;
  readonly setVoice: (voice: VoiceName) => void;
  readonly setSpeed: (speed: number) => void;
  readonly setLanguage: (language: VoiceLanguage) => void;
  readonly setReasoningEffort: (effort: VoiceReasoningEffort) => void;
  readonly setTurnEagerness: (eagerness: VoiceTurnEagerness) => void;
  readonly setNoiseReduction: (noiseReduction: VoiceNoiseReduction) => void;
}

export function normalizeVoiceSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_SPEED;
  const clamped = Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, value));
  return Number((Math.round(clamped / VOICE_SPEED_STEP) * VOICE_SPEED_STEP).toFixed(2));
}

function isOptionValue<T extends string>(
  options: ReadonlyArray<{ readonly value: T }>,
  value: unknown,
): value is T {
  return options.some((option) => option.value === value);
}

export const isVoiceRealtimeModel = (value: unknown): value is VoiceRealtimeModel =>
  isOptionValue(VOICE_MODEL_OPTIONS, value);
export const isVoiceName = (value: unknown): value is VoiceName =>
  isOptionValue(VOICE_OPTIONS, value);
export const isVoiceLanguage = (value: unknown): value is VoiceLanguage =>
  isOptionValue(VOICE_LANGUAGE_OPTIONS, value);
export const isVoiceReasoningEffort = (value: unknown): value is VoiceReasoningEffort =>
  isOptionValue(VOICE_REASONING_OPTIONS, value);
export const isVoiceTurnEagerness = (value: unknown): value is VoiceTurnEagerness =>
  isOptionValue(VOICE_TURN_EAGERNESS_OPTIONS, value);
export const isVoiceNoiseReduction = (value: unknown): value is VoiceNoiseReduction =>
  isOptionValue(VOICE_NOISE_REDUCTION_OPTIONS, value);

export function voiceLanguageLabel(language: VoiceLanguage): string {
  return VOICE_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;
}

export function createOpenAIRealtimeSessionConfig(
  settings: Pick<
    VoiceSettingsState,
    "voice" | "speed" | "language" | "reasoningEffort" | "turnEagerness" | "noiseReduction"
  >,
) {
  return {
    type: "realtime",
    reasoning: { effort: settings.reasoningEffort },
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
          ...(settings.language === "auto" ? {} : { language: settings.language }),
        },
        noise_reduction:
          settings.noiseReduction === "off" ? null : { type: settings.noiseReduction },
        turn_detection: {
          type: "semantic_vad",
          eagerness: settings.turnEagerness,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: settings.voice,
        speed: normalizeVoiceSpeed(settings.speed),
      },
    },
  } as const;
}

if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("t3code:voice-settings:v1");
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

const defaults = {
  model: "gpt-realtime-2.1-mini",
  voice: "marin",
  speed: DEFAULT_VOICE_SPEED,
  language: "auto",
  reasoningEffort: "low",
  turnEagerness: "auto",
  noiseReduction: "far_field",
} as const;

export const useVoiceSettingsStore = create<VoiceSettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      setModel: (model) => set({ model }),
      setVoice: (voice) => set({ voice }),
      setSpeed: (speed) => set({ speed: normalizeVoiceSpeed(speed) }),
      setLanguage: (language) => set({ language }),
      setReasoningEffort: (reasoningEffort) => set({ reasoningEffort }),
      setTurnEagerness: (turnEagerness) => set({ turnEagerness }),
      setNoiseReduction: (noiseReduction) => set({ noiseReduction }),
    }),
    {
      name: "t3code:voice-settings:v2",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: (state) => ({
        model: state.model,
        voice: state.voice,
        speed: state.speed,
        language: state.language,
        reasoningEffort: state.reasoningEffort,
        turnEagerness: state.turnEagerness,
        noiseReduction: state.noiseReduction,
      }),
      merge: (persisted, current) => {
        const value = persisted as Partial<VoiceSettingsState> | undefined;
        return {
          ...current,
          model: isVoiceRealtimeModel(value?.model) ? value.model : defaults.model,
          voice: isVoiceName(value?.voice) ? value.voice : defaults.voice,
          speed: normalizeVoiceSpeed(value?.speed ?? defaults.speed),
          language: isVoiceLanguage(value?.language) ? value.language : defaults.language,
          reasoningEffort: isVoiceReasoningEffort(value?.reasoningEffort)
            ? value.reasoningEffort
            : defaults.reasoningEffort,
          turnEagerness: isVoiceTurnEagerness(value?.turnEagerness)
            ? value.turnEagerness
            : defaults.turnEagerness,
          noiseReduction: isVoiceNoiseReduction(value?.noiseReduction)
            ? value.noiseReduction
            : defaults.noiseReduction,
        };
      },
    },
  ),
);
