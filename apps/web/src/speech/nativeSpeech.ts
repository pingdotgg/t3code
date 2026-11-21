import { m } from "../i18n/messages";
import { msg } from "gt-react";
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
      return reject(new Error(m(msg("System speech is unavailable on this device."))));
    signal.throwIfAborted();
    const speech = window.speechSynthesis;
    const begin = (voices: SpeechSynthesisVoice[]) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(request.text);
      utterance.rate = rate;
      if (request.voice) {
        const voice = voices.find((voice) => voice.voiceURI === request.voice);
        if (!voice)
          return reject(new Error(m(msg("This system voice is unavailable on this device."))));
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
      utterance.onerror = (event) =>
        finish(new Error(m(msg("System speech failed: {error}", { error: event.error }))));
      if (speech.paused) speech.resume();
      speech.speak(utterance);
    };
    if (!request.voice) begin([]);
    else {
      const voices = speech.getVoices();
      if (voices.length) begin(voices);
      else void waitForNativeVoices(speech, signal).then(begin, reject).catch(reject);
    }
  });
}

function waitForNativeVoices(speech: SpeechSynthesis, signal: AbortSignal) {
  return new Promise<SpeechSynthesisVoice[]>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      speech.removeEventListener("voiceschanged", refresh);
      signal.removeEventListener("abort", abort);
    };
    const refresh = () => {
      const voices = speech.getVoices();
      if (voices.length) {
        cleanup();
        resolve(voices);
      }
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve([]);
    }, 1500);
    speech.addEventListener("voiceschanged", refresh);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else refresh();
  });
}
