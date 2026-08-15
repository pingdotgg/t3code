import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

describe("mobile voice transcription settings", () => {
  beforeEach(() => {
    secureStore.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("migrates the existing OpenAI key and uses the current default model", async () => {
    secureStore.set("t3code.voice-transcription.openai-api-key", " legacy-key ");
    const settings = await import("./voiceTranscriptionSettings");

    await settings.loadMobileVoiceTranscriptionSettings();

    expect(settings.getMobileVoiceTranscriptionSettingsSnapshot()).toMatchObject({
      provider: "openai",
      loaded: true,
      providers: {
        openai: { apiKey: "legacy-key", model: "gpt-4o-transcribe" },
        groq: { apiKey: "", model: "whisper-large-v3-turbo" },
      },
    });
  });

  it("stores separate provider keys and a custom model", async () => {
    const settings = await import("./voiceTranscriptionSettings");
    await settings.loadMobileVoiceTranscriptionSettings();

    await settings.saveMobileVoiceTranscriptionSettings({
      provider: "groq",
      providers: {
        openai: { apiKey: "openai-key", model: "gpt-4o-transcribe" },
        groq: { apiKey: "groq-key", model: "future-groq-transcribe" },
      },
    });

    expect(
      settings.activeMobileVoiceTranscriptionConfig(
        settings.getMobileVoiceTranscriptionSettingsSnapshot(),
      ),
    ).toEqual({
      provider: "groq",
      apiKey: "groq-key",
      model: "future-groq-transcribe",
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "t3code.voice-transcription.settings.v2",
      JSON.stringify({
        provider: "groq",
        providers: {
          openai: { apiKey: "openai-key", model: "gpt-4o-transcribe" },
          groq: { apiKey: "groq-key", model: "future-groq-transcribe" },
        },
      }),
    );
  });

  it("keeps the setup editable when saved settings are invalid", async () => {
    secureStore.set("t3code.voice-transcription.settings.v2", "not-json");
    const settings = await import("./voiceTranscriptionSettings");

    await settings.loadMobileVoiceTranscriptionSettings();

    expect(settings.getMobileVoiceTranscriptionSettingsSnapshot()).toMatchObject({
      provider: "openai",
      loaded: true,
      error: "Saved voice dictation settings were invalid. Save them again.",
    });
  });

  it("can retry after the secure store is temporarily unavailable", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("temporarily unavailable"));
    const settings = await import("./voiceTranscriptionSettings");

    await settings.loadMobileVoiceTranscriptionSettings();
    expect(settings.getMobileVoiceTranscriptionSettingsSnapshot()).toMatchObject({
      loaded: false,
      error: "Could not read the saved voice dictation settings.",
    });

    await settings.loadMobileVoiceTranscriptionSettings();
    expect(settings.getMobileVoiceTranscriptionSettingsSnapshot()).toMatchObject({
      loaded: true,
      error: null,
    });
  });
});
