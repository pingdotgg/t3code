import { createAudioPlayer } from "expo-audio";

const sources = {
  start: require("../../../../assets/voice-input/start.wav"),
  stop: require("../../../../assets/voice-input/stop.wav"),
};

export async function playVoiceInputCue(cue: "start" | "stop"): Promise<void> {
  const player = createAudioPlayer(sources[cue], { keepAudioSessionActive: true });
  try {
    await new Promise<void>((resolve) => {
      // A failed player must never leave the microphone waiting for a cue.
      const timeout = setTimeout(finish, 1_500);
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) finish();
      });
      function finish() {
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      }
      player.play();
    });
  } finally {
    // The recording session owns activation and release throughout both cues.
    player.pause(false);
    player.remove();
  }
}
