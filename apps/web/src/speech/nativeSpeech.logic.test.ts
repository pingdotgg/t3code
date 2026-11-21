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
    speech.speak.mockImplementation((utterance: Utterance) => utterance.onend?.());
    await playNativeSpeech(
      { text: "Hello", voice: null },
      new AbortController().signal,
      playing,
      1,
    );
    expect(speech.speak).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("waits for delayed device voices and releases the voice listener on cancellation or timeout", async () => {
  vi.useFakeTimers();
  const events = new EventTarget();
  const voices: { voiceURI: string }[] = [];
  const spoken = Promise.withResolvers<void>();
  const speech = {
    getVoices: () => voices,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    speak: vi.fn((utterance: { onend: () => void }) => {
      utterance.onend();
      spoken.resolve();
    }),
    cancel: vi.fn(),
  };
  vi.stubGlobal("window", { speechSynthesis: speech });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(readonly text: string) {}
    },
  );
  try {
    const pending = playNativeSpeech(
      { text: "Hello", voice: "delayed" },
      new AbortController().signal,
      () => {},
      1,
    );
    expect(speech.speak).not.toHaveBeenCalled();
    voices.push({ voiceURI: "delayed" });
    events.dispatchEvent(new Event("voiceschanged"));
    await spoken.promise;
    await pending;
    expect(speech.speak).toHaveBeenCalledOnce();
    voices.length = 0;
    const controller = new AbortController();
    const aborted = playNativeSpeech(
      { text: "Hello", voice: "delayed" },
      controller.signal,
      () => {},
      1,
    );
    const rejected = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    const missing = playNativeSpeech(
      { text: "Hello", voice: "missing" },
      new AbortController().signal,
      () => {},
      1,
    );
    const unavailable = expect(missing).rejects.toThrow("unavailable");
    await vi.runAllTimersAsync();
    await unavailable;
    expect(speech.removeEventListener).toHaveBeenCalledTimes(3);
    expect(speech.speak).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
