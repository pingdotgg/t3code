import { expect, it, vi } from "vite-plus/test";
import type { AudioMode } from "expo-audio";

const audio = vi.hoisted(() => ({
  setMode: vi.fn<(mode: Partial<AudioMode>) => Promise<void>>(),
}));
vi.mock("expo-audio", () => ({ setAudioModeAsync: audio.setMode }));

import { setVoiceAudioActive } from "./voiceAudio";

it("finishes an old release before activating its successor", async () => {
  let recording = true;
  let currentMode: Partial<AudioMode> = {};
  const releaseStarted = Promise.withResolvers<void>();
  const finishRelease = Promise.withResolvers<void>();
  audio.setMode.mockImplementation(async (mode) => {
    if (mode.allowsRecording === false) {
      releaseStarted.resolve();
      await finishRelease.promise;
    }
    recording = mode.allowsRecording === true;
    currentMode = { ...currentMode, ...mode };
  });
  const release = setVoiceAudioActive(false);
  await releaseStarted.promise;
  const successor = setVoiceAudioActive(true);
  finishRelease.resolve();
  await Promise.all([release, successor]);
  expect(recording).toBe(true);
  audio.setMode.mockRejectedValueOnce(new Error("release failed"));
  await expect(setVoiceAudioActive(false)).rejects.toThrow("release failed");
  await setVoiceAudioActive(true);
  expect(recording).toBe(true);
  await setVoiceAudioActive(false);
  expect(currentMode).toEqual({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
});
