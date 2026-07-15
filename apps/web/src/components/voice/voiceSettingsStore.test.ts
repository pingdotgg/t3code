import { describe, expect, it } from "vite-plus/test";

import { createVoiceAudioConfig, isVoiceLanguage, normalizeVoiceSpeed } from "./voiceSettingsStore";

describe("normalizeVoiceSpeed", () => {
  it("keeps values within Grok's supported range", () => {
    expect(normalizeVoiceSpeed(0.2)).toBe(0.7);
    expect(normalizeVoiceSpeed(1.23)).toBe(1.25);
    expect(normalizeVoiceSpeed(2)).toBe(1.5);
    expect(normalizeVoiceSpeed(Number.NaN)).toBe(1);
  });
});

describe("voice language settings", () => {
  it("accepts supported language codes and Auto", () => {
    expect(isVoiceLanguage("auto")).toBe(true);
    expect(isVoiceLanguage("hi")).toBe(true);
    expect(isVoiceLanguage("es-MX")).toBe(true);
    expect(isVoiceLanguage("es")).toBe(false);
  });

  it("creates the xAI audio session configuration", () => {
    expect(createVoiceAudioConfig(24_000, { speed: 1.2, language: "ja" })).toEqual({
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: "grok-transcribe", language_hint: "ja" },
      },
      output: {
        format: { type: "audio/pcm", rate: 24_000 },
        speed: 1.2,
      },
    });
  });

  it("uses xAI's fallback behavior for automatic language detection", () => {
    expect(
      createVoiceAudioConfig(24_000, { speed: 1, language: "auto" }).input.transcription,
    ).toEqual({ model: "grok-transcribe", language_hint: "auto" });
  });
});
