import { expect, it, vi } from "vite-plus/test";
import * as Speech from "expo-speech";
import { AppState } from "react-native";
import { activateAudioSession, releaseAudioSession } from "../../lib/audioSession";
import { playNativeSpeech } from "./nativeSpeech";

vi.mock("expo-speech", () => ({
  speak: vi.fn(),
  stop: vi.fn(async () => {}),
  getAvailableVoicesAsync: vi.fn(async () => [
    { identifier: "local", name: "Local", language: "en" },
  ]),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock("../../lib/audioSession", () => ({
  acquireAudioSession: () => ({}),
  activateAudioSession: vi.fn(async () => true),
  releaseAudioSession: vi.fn(async () => {}),
  isAudioSessionOwner: () => true,
}));

it("releases audio focus and settles interrupted system speech without leaving an utterance queued", async () => {
  vi.mocked(Speech.speak).mockReset();
  vi.mocked(Speech.stop).mockClear();
  vi.mocked(activateAudioSession).mockClear();
  vi.mocked(releaseAudioSession).mockClear();
  const started = Promise.withResolvers<void>();
  const playing = vi.fn();
  vi.mocked(Speech.speak).mockImplementation((_text, options) => {
    (options?.onStart as (() => void) | undefined)?.();
    started.resolve();
  });
  const signal = new AbortController();
  const pending = playNativeSpeech(
    { text: "Read me", voice: "local" },
    signal.signal,
    playing,
    1.25,
  );
  await started.promise;
  expect(Speech.speak).toHaveBeenCalledWith(
    "Read me",
    expect.objectContaining({ voice: "local", rate: 1.25, useApplicationAudioSession: true }),
  );
  expect(playing).toHaveBeenCalledOnce();
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  signal.abort();
  await rejected;
  expect(Speech.stop).toHaveBeenCalledOnce();
  expect(releaseAudioSession).toHaveBeenCalledOnce();
  await expect(
    playNativeSpeech(
      { text: "Read me", voice: "another-device" },
      new AbortController().signal,
      playing,
      1,
    ),
  ).rejects.toThrow("unavailable");
  expect(Speech.speak).toHaveBeenCalledOnce();
  expect(releaseAudioSession).toHaveBeenCalledTimes(2);
});

it.each(["cancel", "background", "background-return", "play"] as const)(
  "waits for Android speech initialization before handling %s with the default voice",
  async (action) => {
    vi.mocked(Speech.speak).mockReset();
    vi.mocked(AppState.addEventListener).mockClear();
    const removeListener = vi.fn();
    vi.mocked(AppState.addEventListener).mockReturnValueOnce({ remove: removeListener });
    vi.mocked(Speech.stop).mockClear();
    vi.mocked(releaseAudioSession).mockClear();
    const initialized = Promise.withResolvers<Speech.Voice[]>();
    const reachedEngine = Promise.withResolvers<void>();
    vi.mocked(Speech.getAvailableVoicesAsync).mockImplementationOnce(() => {
      reachedEngine.resolve();
      return initialized.promise;
    });
    vi.mocked(Speech.speak).mockImplementation((_text, options) => {
      reachedEngine.resolve();
      (options?.onStart as (() => void) | undefined)?.();
      (options?.onDone as (() => void) | undefined)?.();
    });
    const signal = new AbortController();
    const playing = vi.fn();
    const result = playNativeSpeech(
      { text: "Read me", voice: null },
      signal.signal,
      playing,
      1,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await reachedEngine.promise;
      expect(Speech.speak).not.toHaveBeenCalled();
      if (action === "cancel") signal.abort();
      if (action === "background") AppState.currentState = "background";
      if (action === "background-return") {
        const onStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
        AppState.currentState = "background";
        onStateChange?.("background");
        AppState.currentState = "active";
        onStateChange?.("active");
      }
      initialized.resolve([]);
      const outcome = await result;
      if (action === "play") {
        expect(outcome).toBeNull();
        expect(Speech.speak).toHaveBeenCalledOnce();
        expect(playing).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(Speech.speak).not.toHaveBeenCalled();
        expect(playing).not.toHaveBeenCalled();
      }
      expect(releaseAudioSession).toHaveBeenCalledOnce();
      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      signal.abort();
      initialized.resolve([]);
      await result;
      AppState.currentState = "active";
    }
  },
);
