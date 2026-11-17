import { expect, it, vi } from "vite-plus/test";
import * as Speech from "expo-speech";
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
