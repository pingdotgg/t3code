import { m } from "~/i18n/messages";
import { prepareReadAloudMath } from "./readAloudMath";
import {
  createEnvironmentReadAloud,
  createReadAloudController,
  type SpeechPlayback,
  type SpokenWord,
} from "@t3tools/client-runtime/read-aloud";
import { spokenWordAt } from "@t3tools/shared/read-aloud";
import { readPreparedConnection } from "../state/session";
import { canCapturePlayback, playbackLevels } from "./playbackLevels";
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

const environmentReadAloud = createEnvironmentReadAloud({
  connection: readPreparedConnection,
  run: (effect, signal) => runEnvironmentSpeech(effect, signal && { signal }),
});

export const warmReadAloud = environmentReadAloud.warm;

export const readAloudController = createReadAloudController(
  async (text, settings, signal, from) => {
    if (settings.provider === "system")
      return systemPlayback(text, settings.voice, settings.speed, settings.language);
    const speech = await environmentReadAloud.start(text, settings, signal, from);
    const audio = new Audio();
    // CORS mode, like the environment's API requests, so the waveform can read what plays.
    audio.crossOrigin = "anonymous";
    audio.src = speech.url;
    audio.playbackRate = speech.rate(settings.speed);
    // Where in the speech the element's audio starts, once a seek opened it again.
    let opensAt = 0;
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      done = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Could not play the generated speech."));
    });
    let timed: ReturnType<typeof speech.timedWords> | null = null;
    // Safari cannot capture the audio element's output, so the meter follows the loudness the
    // environment measured instead.
    const measured = !canCapturePlayback(audio);
    const timedWords = () => {
      if (timed) return timed;
      const created = speech.timedWords(
        () => ({
          seconds: opensAt + audio.currentTime,
          rate: audio.playbackRate,
          playing: !audio.paused,
        }),
        measured,
      );
      for (const type of CLOCK_EVENTS) audio.addEventListener(type, created.refresh);
      return (timed = created);
    };
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
      words: (listener) => timedWords().subscribe(listener),
      seek: (at) => {
        const seconds = timed?.secondsAt(at);
        if (seconds === undefined) return false;
        if (seekable(audio, seconds - opensAt)) audio.currentTime = seconds - opensAt;
        else {
          // A live stream ignores seeks beyond what the browser can seek; the environment opens
          // the audio there instead.
          const playing = !audio.paused;
          opensAt = seconds;
          audio.src = speech.urlAt(seconds);
          if (playing) void audio.play().catch(() => {});
        }
        timed?.refresh();
        return true;
      },
      setSpeed: (speed) => {
        audio.playbackRate = speech.rate(speed);
        timed?.refresh();
      },
      levels: (listener) =>
        measured ? timedWords().followLevels(listener) : playbackLevels(audio, listener),
    };
  },
  m,
  prepareReadAloudMath,
);

function seekable(audio: HTMLAudioElement, seconds: number) {
  for (let index = 0; index < audio.seekable.length; index++)
    if (audio.seekable.start(index) <= seconds && seconds <= audio.seekable.end(index)) return true;
  return false;
}
