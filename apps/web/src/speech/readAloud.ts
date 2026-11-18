import { m } from "~/i18n/messages";
import { speechSpeedAppliedByProvider, type SpeechSynthesisCatalog } from "@t3tools/contracts";
import {
  createReadAloudController,
  createReadAloudWarmup,
  type SpeechPlayback,
} from "@t3tools/client-runtime/read-aloud";
import {
  getSpeechSynthesisModels,
  prepareSpeechSynthesis,
  startSpeechSynthesis,
} from "@t3tools/client-runtime/voice-input";
import { readPreparedConnection } from "../state/session";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

function systemPlayback(
  text: string,
  voice: string,
  speed: number,
  language: string,
): SpeechPlayback {
  if (!("speechSynthesis" in window))
    throw new Error("System voices are not available in this browser.");
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = speed;
  if (language !== "auto") utterance.lang = language;
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

const catalogs = new WeakMap<AbortSignal, Promise<SpeechSynthesisCatalog>>();

export const warmReadAloud = createReadAloudWarmup(async (environmentId, model) => {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("The read-aloud environment is not connected.");
  await runEnvironmentSpeech(prepareSpeechSynthesis(prepared, model));
});

export const readAloudController = createReadAloudController(async (text, settings, signal) => {
  if (settings.provider === "system")
    return systemPlayback(text, settings.voice, settings.speed, settings.language);
  if (settings.provider === "off") throw new Error("Enable read aloud in Settings → Voice.");
  const prepared = settings.environmentId ? readPreparedConnection(settings.environmentId) : null;
  if (!prepared)
    throw new Error("Connect to the read-aloud environment selected in Settings → Voice.");
  let pendingCatalog = catalogs.get(signal);
  if (!pendingCatalog) {
    pendingCatalog = runEnvironmentSpeech(getSpeechSynthesisModels(prepared, settings.provider), {
      signal,
    });
    catalogs.set(signal, pendingCatalog);
  }
  const catalog = await pendingCatalog;
  signal.throwIfAborted();
  if (catalog.error) throw new Error(catalog.error);
  const model = settings.model || catalog.defaultModel;
  const url = await runEnvironmentSpeech(
    startSpeechSynthesis(prepared, settings.provider, {
      text,
      model,
      voice: settings.voice,
      speed: settings.speed,
      language: settings.language,
    }),
    { signal },
  );
  signal.throwIfAborted();
  const audio = new Audio(url);
  if (!speechSpeedAppliedByProvider(catalog, model)) audio.playbackRate = settings.speed;
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
      done();
    },
    finished,
  };
}, m);
