import {
  VoiceOutputController,
  type SpeechAudioPlayer,
} from "@t3tools/client-runtime/voice-output";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import {
  createAudioPlaybackSession,
  disposeAudioPlayer,
  pauseAudioPlayer,
} from "../../lib/audioSession";
import { uuidv4 } from "../../lib/uuid";

let current: ReturnType<typeof createAudioPlaybackSession> | null = null;
const player: SpeechAudioPlayer = {
  async play(bytes, signal, onPlaying) {
    const file = new File(Paths.cache, `t3-speech-${uuidv4()}.wav`);
    try {
      signal.throwIfAborted();
      if (AppState.currentState !== "active")
        throw new Error("Open the app before playing a response.");
      file.write(bytes);
      await new Promise<void>((resolve, reject) => {
        const audio = createAudioPlayer(file.uri, { updateInterval: 500 });
        let finished = false;
        const playback = createAudioPlaybackSession(audio, false, (requested) => {
          if (!requested && !finished) finish(new Error("Response playback was interrupted."));
        });
        current = playback;
        currentAudioPause = () => pauseAudioPlayer(audio);
        const status = audio.addListener("playbackStatusUpdate", (value) => {
          if (value.error) finish(new Error("Could not play the generated audio."));
          else if (value.didJustFinish) finish();
        });
        const app = AppState.addEventListener("change", (state) => {
          if (state !== "active") finish(new Error("Response playback stopped in the background."));
        });
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          status.remove();
          app.remove();
          playback.pause();
          disposeAudioPlayer(audio);
          if (current === playback) {
            current = null;
            currentAudioPause = null;
          }
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        void playback.play().then(() => {
          if (!playback.requested) finish(new Error("Finish dictation before playing a response."));
          else if (!finished) onPlaying();
        }, finish);
      });
    } finally {
      if (file.exists) file.delete();
    }
  },
  pause: () => {
    // A user pause retains ownership, so the recorder can still interrupt this playback.
    currentAudioPause?.();
  },
  resume: async () => {
    await current?.play();
  },
};
let currentAudioPause: (() => void) | null = null;

export const voiceOutput = new VoiceOutputController(player);
