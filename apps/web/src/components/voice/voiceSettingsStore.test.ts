import { describe, expect, it } from "vite-plus/test";

import {
  createOpenAIRealtimeSessionConfig,
  isVoiceLanguage,
  normalizeVoiceSpeed,
} from "./voiceSettingsStore";

describe("normalizeVoiceSpeed", () => {
  it("keeps values within OpenAI's supported range", () => {
    expect(normalizeVoiceSpeed(0.2)).toBe(0.25);
    expect(normalizeVoiceSpeed(1.23)).toBe(1.25);
    expect(normalizeVoiceSpeed(2)).toBe(1.5);
    expect(normalizeVoiceSpeed(Number.NaN)).toBe(1);
  });
});

describe("voice language settings", () => {
  it("accepts supported language codes and Auto", () => {
    expect(isVoiceLanguage("auto")).toBe(true);
    expect(isVoiceLanguage("hi")).toBe(true);
    expect(isVoiceLanguage("es")).toBe(true);
    expect(isVoiceLanguage("es-MX")).toBe(false);
  });

  it("creates the OpenAI Realtime session configuration", () => {
    expect(
      createOpenAIRealtimeSessionConfig({
        voice: "marin",
        speed: 1.2,
        language: "ja",
        reasoningEffort: "low",
        turnEagerness: "auto",
        noiseReduction: "far_field",
      }),
    ).toEqual({
      type: "realtime",
      reasoning: { effort: "low" },
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: "ja" },
          noise_reduction: { type: "far_field" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: "marin", speed: 1.2 },
      },
    });
  });

  it("omits the language hint for automatic detection", () => {
    expect(
      createOpenAIRealtimeSessionConfig({
        voice: "marin",
        speed: 1,
        language: "auto",
        reasoningEffort: "low",
        turnEagerness: "auto",
        noiseReduction: "off",
      }).audio.input,
    ).toMatchObject({
      transcription: { model: "gpt-4o-mini-transcribe" },
      noise_reduction: null,
    });
  });
});
