import type { NativeSpeechRequest } from "@t3tools/client-runtime/voice-output";

export const nativeSpeechAvailable = () =>
  typeof window !== "undefined" && "speechSynthesis" in window;
export const nativeSpeechVoices = () =>
  nativeSpeechAvailable()
    ? window.speechSynthesis
        .getVoices()
        .map((voice) => ({ id: voice.voiceURI, name: voice.name, language: voice.lang }))
    : [];

export function playNativeSpeech(
  request: NativeSpeechRequest,
  signal: AbortSignal,
  onPlaying: () => void,
  rate: number,
) {
  return new Promise<void>((resolve, reject) => {
    if (!nativeSpeechAvailable())
      return reject(new Error("System speech is unavailable on this device."));
    signal.throwIfAborted();
    const speech = window.speechSynthesis;
    const voices = speech.getVoices();
    if (voices.length === 0)
      return reject(new Error("System speech is unavailable on this device."));
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.rate = rate;
    if (request.voice) {
      const voice = voices.find((voice) => voice.voiceURI === request.voice);
      if (!voice) return reject(new Error("This system voice is unavailable on this device."));
      utterance.voice = voice;
    }
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      utterance.onstart = null;
      utterance.onend = null;
      utterance.onerror = null;
      speech.cancel();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    utterance.onstart = onPlaying;
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(`System speech failed: ${event.error}`));
    if (speech.paused) speech.resume();
    speech.speak(utterance);
  });
}
