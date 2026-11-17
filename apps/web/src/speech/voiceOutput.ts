import { playNativeSpeech } from "./nativeSpeech";
import {
  VoiceOutputController,
  type SpeechAudioPlayer,
  type NativeSpeechRequest,
} from "@t3tools/client-runtime/voice-output";

let audio: HTMLAudioElement | null = null;
let recording = false;
let nativeActive: object | null = null;

const player: SpeechAudioPlayer<Uint8Array | NativeSpeechRequest> = {
  play(bytes, signal, onPlaying, rate) {
    if (!(bytes instanceof Uint8Array)) {
      const identity = {};
      nativeActive = identity;
      return playNativeSpeech(bytes, signal, onPlaying, rate).finally(() => {
        if (nativeActive === identity) nativeActive = null;
      });
    }
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }));
      const element = new Audio(url);
      audio = element;
      element.preservesPitch = true;
      element.playbackRate = rate;
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        element.onended = null;
        element.onerror = null;
        signal.removeEventListener("abort", onAbort);
        element.pause();
        element.removeAttribute("src");
        element.load();
        URL.revokeObjectURL(url);
        if (audio === element) audio = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(signal.reason);
      element.onended = () => finish();
      element.onerror = () => finish(new Error("Could not play the generated audio."));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void element.play().then(() => {
        if (!signal.aborted) onPlaying();
      }, finish);
    });
  },
  setPlaybackRate: (rate) => {
    if (audio) audio.playbackRate = rate;
  },
  pause: () => (nativeActive ? window.speechSynthesis.pause() : audio?.pause()),
  resume: () => {
    if (nativeActive) {
      window.speechSynthesis.resume();
      return Promise.resolve();
    }
    return audio?.play() ?? Promise.resolve();
  },
};

export const voiceOutput = new VoiceOutputController(player);
export const isVoiceRecordingActive = () => recording;
export function setVoiceRecordingActive(active: boolean) {
  recording = active;
  if (active) voiceOutput.stop();
}
