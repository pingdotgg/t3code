import type { SpeechSettings } from "@t3tools/contracts";
import { create } from "zustand";

import { speechChunks } from "./speechText";

export type SpeechPlaybackStatus = "idle" | "speaking" | "paused";

interface SpeechPlaybackState {
  readonly status: SpeechPlaybackStatus;
  /** What is being read, such as a message id, so its replay button can show it. */
  readonly sourceId: string | null;
  readonly sourceLabel: string | null;
  /** Host speech cannot pause; the bar only offers Stop then. */
  readonly canPause: boolean;
}

export const useSpeechPlayback = create<SpeechPlaybackState>(() => ({
  status: "idle",
  sourceId: null,
  sourceLabel: null,
  canPause: false,
}));

/** The host machine's speech engine, reached through the primary environment. */
export interface HostSpeech {
  readonly speak: (input: {
    readonly text: string;
    readonly voice: string;
    readonly rate: number;
    readonly pitch: number;
    readonly volume: number;
  }) => Promise<"completed" | "interrupted" | "failed">;
  readonly stop: () => void;
}

let hostSpeech: HostSpeech | null = null;

export function registerHostSpeech(host: HostSpeech | null) {
  hostSpeech = host;
}

export function webSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Whether `speak` can do anything with these settings. */
export function speechAvailable(settings: Pick<SpeechSettings, "engine">): boolean {
  return settings.engine === "host" ? hostSpeech !== null : webSpeechAvailable();
}

/** The engine's voices. Chromium loads them asynchronously, so this waits briefly once. */
export async function loadSpeechVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!webSpeechAvailable()) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) return voices;
  return new Promise((resolve) => {
    const done = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      window.clearTimeout(timer);
      resolve(window.speechSynthesis.getVoices());
    };
    const timer = window.setTimeout(done, 1500);
    window.speechSynthesis.addEventListener("voiceschanged", done);
  });
}

type VoiceSettings = Pick<
  SpeechSettings,
  "engine" | "voice" | "hostVoice" | "rate" | "pitch" | "volume"
>;
interface Source {
  readonly id: string;
  readonly label: string;
}

let queue: string[] = [];
let settingsForQueue: VoiceSettings | null = null;
let generation = 0;
let playing = false;

function setState(patch: Partial<SpeechPlaybackState>) {
  useSpeechPlayback.setState(patch);
}

function finish(current: number) {
  if (current !== generation) return;
  playing = false;
  setState({ status: "idle", sourceId: null, sourceLabel: null, canPause: false });
}

function speakNext(current: number) {
  if (current !== generation || !settingsForQueue) return;
  const next = queue.shift();
  if (next === undefined) {
    finish(current);
    return;
  }
  playing = true;
  const settings = settingsForQueue;
  if (settings.engine === "host") {
    if (!hostSpeech) {
      finish(current);
      return;
    }
    void hostSpeech
      .speak({
        text: next,
        voice: settings.hostVoice,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
      })
      .then((result) => {
        if (result === "completed") speakNext(current);
        else finish(current);
      });
    return;
  }
  const utterance = new SpeechSynthesisUtterance(next);
  const voice = window.speechSynthesis
    .getVoices()
    .find((candidate) => candidate.voiceURI === settings.voice);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = settings.rate;
  utterance.pitch = settings.pitch;
  utterance.volume = settings.volume;
  utterance.addEventListener("end", () => speakNext(current));
  utterance.addEventListener("error", (event) => {
    // `interrupted` and `canceled` come from our own stop; anything else ends this source.
    if (event.error === "interrupted" || event.error === "canceled") return;
    finish(current);
  });
  window.speechSynthesis.speak(utterance);
}

/** Reads `text` aloud, replacing whatever was playing. */
export function speak(text: string, settings: VoiceSettings, source: Source) {
  if (!speechAvailable(settings) || text.trim() === "") return;
  stopSpeaking();
  generation += 1;
  queue = speechChunks(text);
  settingsForQueue = settings;
  setState({
    status: "speaking",
    sourceId: source.id,
    sourceLabel: source.label,
    canPause: settings.engine === "system",
  });
  speakNext(generation);
}

/** Streaming speech: adds text to the current source without restarting it. */
export function appendSpeech(text: string, settings: VoiceSettings, source: Source) {
  if (!speechAvailable(settings) || text.trim() === "") return;
  const state = useSpeechPlayback.getState();
  if (state.sourceId !== source.id || state.status === "idle") {
    speak(text, settings, source);
    return;
  }
  queue.push(...speechChunks(text));
  settingsForQueue = settings;
  if (!playing) speakNext(generation);
}

export function pauseSpeaking() {
  const state = useSpeechPlayback.getState();
  if (!webSpeechAvailable() || state.status !== "speaking" || !state.canPause) return;
  window.speechSynthesis.pause();
  setState({ status: "paused" });
}

export function resumeSpeaking() {
  if (!webSpeechAvailable() || useSpeechPlayback.getState().status !== "paused") return;
  window.speechSynthesis.resume();
  setState({ status: "speaking" });
}

export function stopSpeaking() {
  generation += 1;
  queue = [];
  playing = false;
  if (webSpeechAvailable()) window.speechSynthesis.cancel();
  if (settingsForQueue?.engine === "host") hostSpeech?.stop();
  if (useSpeechPlayback.getState().status !== "idle") {
    setState({ status: "idle", sourceId: null, sourceLabel: null, canPause: false });
  }
}
