import { createReadAloudController, type SpeechPlayback } from "@t3tools/client-runtime/read-aloud";
import { synthesizeSpeech } from "@t3tools/client-runtime/voice-input";
import { speechAudioMimeType } from "@t3tools/shared/read-aloud";
import { readPreparedConnection } from "../state/session";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

function systemPlayback(text: string, voice: string, speed: number): SpeechPlayback {
  if (!("speechSynthesis" in window))
    throw new Error("System voices are not available in this browser.");
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = speed;
  utterance.voice = speechSynthesis.getVoices().find((entry) => entry.voiceURI === voice) ?? null;
  let done: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const finished = new Promise<void>((resolve, fail) => {
    done = resolve;
    reject = fail;
  });
  utterance.onend = done;
  utterance.onerror = () => reject(new Error("The system voice could not read this response."));
  let started = false;
  return {
    play: async () => {
      if (started) speechSynthesis.resume();
      else {
        started = true;
        speechSynthesis.resume();
        speechSynthesis.speak(utterance);
      }
    },
    pause: () => speechSynthesis.pause(),
    stop: () => {
      utterance.onerror = null;
      speechSynthesis.cancel();
      done();
    },
    finished,
  };
}

export const readAloudController = createReadAloudController(async (text, settings, signal) => {
  if (settings.provider === "system") return systemPlayback(text, settings.voice, settings.speed);
  if (settings.provider === "off") throw new Error("Enable read aloud in Settings → Voice.");
  const prepared = settings.environmentId ? readPreparedConnection(settings.environmentId) : null;
  if (!prepared)
    throw new Error("Connect to the read-aloud environment selected in Settings → Voice.");
  const bytes = await runEnvironmentSpeech(
    synthesizeSpeech(prepared, settings.provider, {
      text,
      model: settings.model,
      voice: settings.voice,
      speed: settings.speed,
      language: settings.language,
    }),
    { signal },
  );
  signal.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: speechAudioMimeType(bytes) }),
  );
  const audio = new Audio(url);
  if (settings.provider === "chatgpt" || settings.provider === "openrouter")
    audio.playbackRate = settings.speed;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    done = resolve;
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Could not play the generated speech."));
  });
  return {
    play: () => audio.play(),
    pause: () => audio.pause(),
    stop: () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      done();
    },
    finished,
  };
});
