import { createAudioPlayer } from "expo-audio";

const sources = {
  start: require("../../../../assets/voice-input/start.wav"),
  stop: require("../../../../assets/voice-input/stop.wav"),
};

export async function playVoiceInputCue(cue: "start" | "stop"): Promise<void> {
  const player = createAudioPlayer(sources[cue], { keepAudioSessionActive: true });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const subscription = player.addListener("playbackStatusUpdate", (status) => {
    if (status.didJustFinish) finish();
  });
  // A failed player must never leave the microphone waiting for a cue.
  const timeout = setTimeout(finish, 1_500);
  try {
    player.play();
    await done;
  } finally {
    clearTimeout(timeout);
    subscription.remove();
    // The recording session owns activation and release throughout both cues.
    player.pause(false);
    player.remove();
  }
}
