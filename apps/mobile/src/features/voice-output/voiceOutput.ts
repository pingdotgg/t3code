import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import {
  VoiceOutputController,
  type SpeechAudioPlayer,
  type NativeSpeechRequest,
} from "@t3tools/client-runtime/voice-output";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";
import { playNativeSpeech } from "./nativeSpeech";
import { Platform, AppState } from "react-native";
import {
  createAudioPlaybackSession,
  disposeAudioPlayer,
  pauseAudioPlayer,
} from "../../lib/audioSession";
import { uuidv4 } from "../../lib/uuid";

let current: ReturnType<typeof createAudioPlaybackSession> | null = null;
let nativeActive: object | null = null;
const player: SpeechAudioPlayer<Uint8Array | NativeSpeechRequest> = {
  async play(bytes, signal, onPlaying, rate) {
    if (!(bytes instanceof Uint8Array)) {
      const identity = {};
      nativeActive = identity;
      try {
        await playNativeSpeech(bytes, signal, onPlaying, rate);
      } finally {
        if (nativeActive === identity) nativeActive = null;
      }
      return;
    }
    const file = new File(Paths.cache, `t3-speech-${uuidv4()}.wav`);
    try {
      signal.throwIfAborted();
      if (AppState.currentState !== "active")
        throw new Error(m(msg("Open the app before playing a response.")));
      file.write(bytes);
      await new Promise<void>((resolve, reject) => {
        const audio = createAudioPlayer(file.uri, { updateInterval: 500 });
        audio.shouldCorrectPitch = true;
        audio.setPlaybackRate(rate, "high");
        currentAudioRate = (rate) => audio.setPlaybackRate(rate, "high");
        let finished = false;
        const playback = createAudioPlaybackSession(audio, false, (requested) => {
          if (!requested && !finished)
            finish(new Error(m(msg("Response playback was interrupted."))));
        });
        current = playback;
        currentAudioPause = () => pauseAudioPlayer(audio);
        const status = audio.addListener("playbackStatusUpdate", (value) => {
          if (value.error) finish(new Error(m(msg("Could not play the generated audio."))));
          else if (value.didJustFinish) finish();
        });
        const app = AppState.addEventListener("change", (state) => {
          if (state !== "active")
            finish(new Error(m(msg("Response playback stopped in the background."))));
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
            currentAudioRate = null;
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
          if (!playback.requested)
            finish(new Error(m(msg("Finish dictation before playing a response."))));
          else if (!finished) onPlaying();
        }, finish);
      });
    } finally {
      if (file.exists) file.delete();
    }
  },
  setPlaybackRate: (rate) => currentAudioRate?.(rate),
  canPause: () => !nativeActive || Platform.OS !== "android",
  pause: () => {
    if (nativeActive) return Speech.pause();
    // A user pause retains ownership, so the recorder can still interrupt this playback.
    currentAudioPause?.();
  },
  resume: async () => {
    if (nativeActive) return Speech.resume();
    await current?.play();
  },
};
let currentAudioRate: ((rate: number) => void) | null = null;
let currentAudioPause: (() => void) | null = null;

export const voiceOutput = new VoiceOutputController(player, m);
