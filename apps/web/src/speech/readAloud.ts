import { m } from "~/i18n/messages";
import { speechSpeedAppliedByProvider, type SpeechSynthesisCatalog } from "@t3tools/contracts";
import {
  createReadAloudController,
  createReadAloudWarmup,
  createTimedWords,
  type SpeechPlayback,
  type SpokenWord,
} from "@t3tools/client-runtime/read-aloud";
import {
  getSpeechSynthesisModels,
  getSpeechSynthesisTimings,
  prepareSpeechSynthesis,
  startSpeechSynthesis,
} from "@t3tools/client-runtime/voice-input";
import { spokenWordAt } from "@t3tools/shared/read-aloud";
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
  const listeners = new Set<(word: SpokenWord | null) => void>();
  // Some voices, such as Chrome's network voices, send no boundaries; those read unhighlighted.
  utterance.onboundary = (event) => {
    if (event.name !== "word") return;
    const word = spokenWordAt(text, event.charIndex);
    for (const listener of listeners) listener(word);
  };
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
    words: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Each one moves the media clock or starts or stops it.
const CLOCK_EVENTS = ["play", "playing", "pause", "seeked", "ratechange", "waiting"] as const;

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
  const { url, token } = await runEnvironmentSpeech(
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
  let timed: ReturnType<typeof createTimedWords> | null = null;
  return {
    play: () => audio.play(),
    pause: () => audio.pause(),
    stop: () => {
      if (timed) for (const type of CLOCK_EVENTS) audio.removeEventListener(type, timed.refresh);
      timed?.stop();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      done();
    },
    finished,
    words: (listener) => {
      if (!timed) {
        timed = createTimedWords({
          text,
          wordTimings: catalog.wordTimings ?? "estimated",
          load: (after, signal) =>
            runEnvironmentSpeech(getSpeechSynthesisTimings(prepared, token, after), { signal }),
          clock: () => ({
            seconds: audio.currentTime,
            rate: audio.playbackRate,
            playing: !audio.paused,
          }),
        });
        for (const type of CLOCK_EVENTS) audio.addEventListener(type, timed.refresh);
      }
      return timed.subscribe(listener);
    },
  };
}, m);
