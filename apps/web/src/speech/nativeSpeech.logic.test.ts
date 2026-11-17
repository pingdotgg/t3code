import { expect, it, vi } from "vite-plus/test";
import { nativeSpeechVoices, playNativeSpeech } from "./nativeSpeech";

it("uses device voices without uploads, settles cancellation, and rejects unavailable voices", async () => {
  const speech = {
    getVoices: () => [{ voiceURI: "device-voice", name: "Device", lang: "en" }],
    speak: vi.fn(),
    cancel: vi.fn(),
  };
  class Utterance {
    constructor(readonly text: string) {}
    rate = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
  }
  vi.stubGlobal("window", { speechSynthesis: speech });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  try {
    expect(nativeSpeechVoices()).toEqual([{ id: "device-voice", name: "Device", language: "en" }]);
    const controller = new AbortController();
    const playing = vi.fn();
    const pending = playNativeSpeech(
      { text: "Hello", voice: "device-voice" },
      controller.signal,
      playing,
      1.5,
    );
    const utterance = speech.speak.mock.calls[0]![0] as Utterance;
    expect(utterance).toMatchObject({
      text: "Hello",
      rate: 1.5,
      voice: { voiceURI: "device-voice" },
    });
    utterance.onstart?.();
    expect(playing).toHaveBeenCalledOnce();
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(speech.cancel).toHaveBeenCalledOnce();
    expect(utterance.onend).toBeNull();
    await expect(
      playNativeSpeech(
        { text: "Hello", voice: "other-device" },
        new AbortController().signal,
        playing,
        1,
      ),
    ).rejects.toThrow("unavailable");
    expect(speech.speak).toHaveBeenCalledOnce();
    speech.getVoices = () => [];
    speech.speak.mockImplementation(() => {
      throw new Error("Unexpected speech invocation");
    });
    await expect(
      playNativeSpeech({ text: "Hello", voice: null }, new AbortController().signal, playing, 1),
    ).rejects.toThrow("unavailable");
    expect(speech.speak).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
