import {
  SPEECH_SYNTHESIS_MAX_TEXT,
  type EnvironmentId,
  type ReadAloudSettings,
  type ReadAloudWordTimings,
  type SpeechSynthesisTimings,
  type SpeechSynthesisWord,
} from "@t3tools/contracts";
import {
  readAloudPosition,
  readAloudSpeech,
  splitReadAloudSpans,
  type ReadAloudPosition,
} from "@t3tools/shared/read-aloud";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const WARM_INTERVAL_MS = 4 * 60_000;

/**
 * Asks an environment to load its local model before playback, at most once per interval for each
 * environment and model. A failed request is retried the next time.
 */
export function createReadAloudWarmup(
  warm: (environmentId: EnvironmentId, model: string) => Promise<unknown>,
  now: () => number = Date.now,
) {
  const requested = new Map<string, number>();
  return (settings: ReadAloudSettings) => {
    if (settings.provider !== "local" || !settings.environmentId) return;
    const key = JSON.stringify([settings.environmentId, settings.model]);
    const last = requested.get(key);
    if (last !== undefined && now() - last < WARM_INTERVAL_MS) return;
    requested.set(key, now());
    void warm(settings.environmentId, settings.model).catch(() => requested.delete(key));
  };
}

/** A word as UTF-16 offsets in the text a playback speaks. */
export type SpokenWord = { readonly start: number; readonly end: number };

export type SpeechPlayback = {
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  finished: Promise<void>;
  /** Reports each word as it is spoken, and null when none is; returns the unsubscribe. */
  words?: (listener: (word: SpokenWord | null) => void) => () => void;
};

/** What a read-aloud message is reading now, for clients to highlight. */
export type ReadAloudHighlight = ReadAloudPosition & { readonly id: string };

/** Index of the word being spoken at `seconds`: the last one started, or -1 before the first. */
function wordIndexAt(words: ReadonlyArray<SpeechSynthesisWord>, seconds: number) {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((words[middle]?.startSeconds ?? Infinity) <= seconds) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Spreads the words of `text` over its audio by length, with longer pauses after punctuation. */
function estimateWordTimings(text: string, durationSeconds: number): SpeechSynthesisWord[] {
  const matches = [...text.matchAll(/\S+/g)];
  const weights = matches.map(
    ([word]) =>
      word.length + 1 + (/[.!?。！？]$/u.test(word) ? 4 : /[,;:，、；：]$/u.test(word) ? 2 : 0),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return matches.map((match, index) => {
    const startSeconds = (elapsed / total) * durationSeconds;
    elapsed += weights[index] ?? 0;
    return {
      start: match.index,
      end: match.index + match[0].length,
      startSeconds,
      endSeconds: (elapsed / total) * durationSeconds,
    };
  });
}

export type PlaybackClock = {
  readonly seconds: number;
  readonly rate: number;
  readonly playing: boolean;
};

/**
 * Follows a synthesis' word timings on its audio clock. Players call `refresh` on each media event
 * that moves the clock; between events one timer waits for the next word, not a frame loop.
 * Without provider timings, words are estimated once the environment reports the audio length.
 */
export function createTimedWords(input: {
  readonly text: string;
  readonly wordTimings: ReadAloudWordTimings;
  readonly load: (after: number, signal: AbortSignal) => Promise<SpeechSynthesisTimings>;
  readonly clock: () => PlaybackClock;
}) {
  const loading = new AbortController();
  const listeners = new Set<(word: SpokenWord | null) => void>();
  let words: ReadonlyArray<SpeechSynthesisWord> = [];
  let current = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = undefined;
    if (loading.signal.aborted) return;
    const clock = input.clock();
    const index = wordIndexAt(words, clock.seconds);
    if (index !== current) {
      current = index;
      const word = words[index];
      for (const listener of listeners)
        listener(word ? { start: word.start, end: word.end } : null);
    }
    const next = words[index + 1];
    if (clock.playing && next)
      // @effect-diagnostics-next-line globalTimers:off - Players call this outside an Effect runtime.
      timer = setTimeout(
        refresh,
        Math.max(0, ((next.startSeconds - clock.seconds) / Math.max(clock.rate, 0.1)) * 1000),
      );
  };
  const load = async () => {
    const received: SpeechSynthesisWord[] = [];
    for (;;) {
      const timings = await input.load(received.length, loading.signal);
      received.push(...timings.words);
      if (input.wordTimings !== "estimated") words = received;
      if (timings.done && words.length === 0 && timings.durationSeconds)
        words = estimateWordTimings(input.text, timings.durationSeconds);
      refresh();
      if (timings.done) return;
    }
  };
  // Highlighting is best effort; the audio plays on without it.
  void load().catch(() => {});
  return {
    subscribe: (listener: (word: SpokenWord | null) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    stop: () => {
      loading.abort();
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

export function createReadAloudController(
  prepare: (
    text: string,
    settings: ReadAloudSettings,
    signal: AbortSignal,
  ) => Promise<SpeechPlayback>,
  resolve: MFunctionType = mFallback,
) {
  type State = {
    id: string | null;
    status: "idle" | "loading" | "playing" | "paused" | "error";
    error?: string;
  };
  let state: State = { id: null, status: "idle" };
  let active: AbortController | null = null;
  let playback: SpeechPlayback | null = null;
  let disposing = false;
  const dispose = (current: SpeechPlayback) => {
    disposing = true;
    try {
      current.stop();
    } finally {
      disposing = false;
    }
  };
  let paused = false;
  let starting = false;
  let resumePending: (() => void) | null = null;
  const waitForResume = async () => {
    if (paused)
      await new Promise<void>((resolve) => {
        resumePending = resolve;
      });
  };
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // Separate from `state` so a new word re-renders only the message being read.
  let highlight: ReadAloudHighlight | null = null;
  let unfollow: (() => void) | null = null;
  const highlightListeners = new Set<() => void>();
  const publishHighlight = (next: ReadAloudHighlight | null) => {
    if (next === highlight) return;
    highlight = next;
    for (const listener of highlightListeners) listener();
  };
  const stopFollowing = () => {
    unfollow?.();
    unfollow = null;
    publishHighlight(null);
  };
  const stop = () => {
    stopFollowing();
    active?.abort();
    active = null;
    paused = false;
    starting = false;
    resumePending?.();
    resumePending = null;
    if (playback) dispose(playback);
    playback = null;
    publish({ id: null, status: "idle" });
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getHighlight: () => highlight,
    subscribeHighlight: (listener: () => void) => {
      highlightListeners.add(listener);
      return () => {
        highlightListeners.delete(listener);
      };
    },
    stop,
    pause() {
      if (disposing || !active || (state.status !== "playing" && state.status !== "loading"))
        return;
      paused = true;
      publish({ ...state, status: "paused" });
      if (!starting) playback?.pause();
    },
    async resume() {
      if (state.status !== "paused" || !active) return;
      paused = false;
      if (resumePending) {
        const resume = resumePending;
        resumePending = null;
        publish({ ...state, status: "loading" });
        resume();
        return;
      }
      if (starting || !playback) {
        publish({ ...state, status: "loading" });
        return;
      }
      const owner = active;
      const id = state.id;
      try {
        starting = true;
        publish({ ...state, status: "loading" });
        await playback.play();
        if (active === owner) {
          starting = false;
          if (paused) playback.pause();
          else publish({ ...state, status: "playing" });
        }
      } catch {
        if (active === owner) {
          stop();
          publish({ id, status: "error", error: resolve(msg("Could not resume speech.")) });
        }
      }
    },
    async start(id: string, markdown: string, settings: ReadAloudSettings) {
      stop();
      if (settings.provider === "off") return;
      const speech = readAloudSpeech(markdown, settings.skipCodeBlocks);
      // Platform speech engines cap utterance length; environments stream a whole reply.
      const chunks = splitReadAloudSpans(
        speech.text,
        settings.provider === "system" ? undefined : SPEECH_SYNTHESIS_MAX_TEXT,
      );
      if (!chunks.length) return;
      const owner = new AbortController();
      active = owner;
      try {
        for (const chunk of chunks) {
          publish({ id, status: paused ? "paused" : "loading" });
          const next = await prepare(chunk.text, settings, owner.signal);
          if (active !== owner) {
            dispose(next);
            return;
          }
          playback = next;
          if (settings.highlightWords && next.words)
            unfollow = next.words((word) => {
              const position =
                word && readAloudPosition(speech, chunk.start + word.start, chunk.start + word.end);
              publishHighlight(position ? { id, ...position } : null);
            });
          // Playback can fail while the platform is still activating its audio session.
          void next.finished.catch(() => {});
          await waitForResume();
          if (active !== owner) return;
          do {
            starting = true;
            await next.play();
            if (active !== owner) return;
            starting = false;
            if (paused) {
              next.pause();
              await waitForResume();
              if (active !== owner) return;
            } else break;
          } while (active === owner);
          publish({ id, status: "playing" });
          await next.finished;
          if (active !== owner) return;
          stopFollowing();
          dispose(next);
          playback = null;
        }
        if (active === owner) stop();
      } catch (error) {
        if (active !== owner) return;
        stop();
        publish({
          id,
          status: "error",
          error:
            error instanceof Error ? error.message : resolve(msg("Could not read this response.")),
        });
      }
    },
  };
}
