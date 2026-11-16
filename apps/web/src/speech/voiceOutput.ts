import {
  VoiceOutputController,
  type SpeechAudioPlayer,
} from "@t3tools/client-runtime/voice-output";

let audio: HTMLAudioElement | null = null;
let recording = false;

const player: SpeechAudioPlayer = {
  play(bytes, signal, onPlaying, rate) {
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
  pause: () => audio?.pause(),
  resume: () => audio?.play() ?? Promise.resolve(),
};

export const voiceOutput = new VoiceOutputController(player);
export const isVoiceRecordingActive = () => recording;
export function setVoiceRecordingActive(active: boolean) {
  recording = active;
  if (active) voiceOutput.stop();
}
