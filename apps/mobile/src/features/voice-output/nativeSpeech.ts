import { m } from "../../i18n/messages";
import { msg } from "gt-react-native";
import * as Speech from "expo-speech";
import { AppState, Platform } from "react-native";
import type { NativeSpeechRequest } from "@t3tools/client-runtime/voice-output";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
  isAudioSessionOwner,
} from "../../lib/audioSession";

let pendingStop = Promise.resolve();
const stopSpeech = () => {
  pendingStop = pendingStop.then(() => Speech.stop()).catch(() => {});
};

export const nativeSpeechVoices = async () =>
  (await Speech.getAvailableVoicesAsync()).map((voice) => ({
    id: voice.identifier,
    name: voice.name,
    language: voice.language,
  }));

export async function playNativeSpeech(
  request: NativeSpeechRequest,
  signal: AbortSignal,
  onPlaying: () => void,
  rate: number,
) {
  signal.throwIfAborted();
  let interrupted = false;
  let interrupt: () => void = () => {
    interrupted = true;
  };
  const token = acquireAudioSession("playback", () => interrupt());
  const app = AppState.addEventListener("change", (state) => {
    if (state !== "active") interrupt();
  });
  try {
    if (!(await activateAudioSession(token)))
      throw new Error(m(msg("Finish dictation before playing a response.")));
    signal.throwIfAborted();
    if (AppState.currentState !== "active")
      throw new Error(m(msg("Open the app before playing a response.")));
    // Android queues speech during initialization, and stop() cannot clear that queue.
    const voices = request.voice || Platform.OS === "android" ? await nativeSpeechVoices() : [];
    if (request.voice && !voices.some((voice) => voice.id === request.voice))
      throw new Error(m(msg("This system voice is unavailable on this device.")));
    signal.throwIfAborted();
    await pendingStop;
    signal.throwIfAborted();
    if (AppState.currentState !== "active")
      throw new Error(m(msg("Open the app before playing a response.")));
    if (interrupted || !isAudioSessionOwner(token))
      throw new Error(m(msg("Response playback was interrupted.")));
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        stopSpeech();
        finish(signal.reason ?? new Error(m(msg("Response playback was interrupted."))));
      };
      interrupt = abort;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      Speech.speak(request.text, {
        rate,
        ...(request.voice ? { voice: request.voice } : {}),
        useApplicationAudioSession: true,
        onStart: onPlaying,
        onDone: () => finish(),
        onStopped: () => finish(new Error(m(msg("Response playback was interrupted.")))),
        onError: (error) => finish(error),
      });
    });
  } finally {
    app.remove();
    await releaseAudioSession(token);
  }
}
