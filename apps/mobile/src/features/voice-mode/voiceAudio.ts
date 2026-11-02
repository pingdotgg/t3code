import { setAudioModeAsync } from "expo-audio";

// Expo audio-mode changes must finish before a successor configures the shared native session.
let pending = Promise.resolve();

export function setVoiceAudioActive(active: boolean): Promise<void> {
  const result = pending.then(() =>
    setAudioModeAsync(
      active
        ? {
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: "doNotMix",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          }
        : {
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: "mixWithOthers",
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          },
    ),
  );
  pending = result.catch(() => {});
  return result;
}
