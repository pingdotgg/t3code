import {
  SPEECH_SYNTHESIS_MAX_TEXT,
  type EnvironmentId,
  type ReadAloudSettings,
  type SpeechSynthesisLevel,
  type SpeechSynthesisTimings,
  type SpeechSynthesisWord,
} from "@t3tools/contracts";
import {
  READ_ALOUD_LEVEL_INTERVAL_MS,
  readAloudBlockFrom,
  readAloudPosition,
  readAloudSentenceStart,
  readAloudSpeech,
  smoothReadAloudLevel,
  splitReadAloudSpans,
  spokenWordAt,
  type ReadAloudSpeech,
  type ReadAloudPosition,
  type ReadAloudWords,
  type SpeakMath,
} from "@t3tools/shared/read-aloud";
import { prepareReadAloudEmoji } from "./readAloudEmoji.ts";
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
  /** Moves to the word at offset `at` of the text it speaks; false while its time is unknown. */
  seek?: (at: number) => boolean;
  /** Plays at `speed` from now on, for players that can change rate mid-speech. */
  setSpeed?: (speed: number) => void;
  /** Reports how loud what plays is, from 0 to 1, while it plays; returns the unsubscribe. */
  levels?: (listener: (level: number) => void) => () => void;
};

/** What a read-aloud message is reading now, for clients to highlight. */
export type ReadAloudHighlight = ReadAloudPosition & { readonly id: string };

/** Index of the word being spoken at `seconds`: the last one started, or -1 before the first. */
// A seek to a word's start can land up to an MP3 frame before it; that still counts as the word.
const WORD_START_TOLERANCE_SECONDS = 0.06;

function wordIndexAt(words: ReadonlyArray<SpeechSynthesisWord>, seconds: number) {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((words[middle]?.startSeconds ?? Infinity) <= seconds + WORD_START_TOLERANCE_SECONDS) {
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

/** The loudness at `seconds`: the nearest level, or 0 past the levels that have arrived. */
function levelAt(levels: ReadonlyArray<SpeechSynthesisLevel>, seconds: number) {
  let low = 0;
  let high = levels.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (levels[middle]!.seconds <= seconds) low = middle + 1;
    else high = middle - 1;
  }
  const before = levels[high];
  const after = levels[low];
  if (!after) {
    // Past the last level by more than the spacing between levels, the audio is not measured yet.
    const spacing = before && levels[high - 1] ? before.seconds - levels[high - 1]!.seconds : 0;
    return before && seconds - before.seconds <= spacing ? before.level : 0;
  }
  return !before || after.seconds - seconds < seconds - before.seconds ? after.level : before.level;
}

/**
 * Follows a synthesis' word timings on its audio clock; players call `refresh` when the clock
 * moves. Words missing from the environment are estimated once it reports the audio length.
 * `levels` also follows the loudness it measured, for players that cannot measure their audio.
 */
export function createTimedWords(input: {
  readonly text: string;
  readonly load: (
    after: number,
    levelsAfter: number | undefined,
    signal: AbortSignal,
  ) => Promise<SpeechSynthesisTimings>;
  readonly clock: () => PlaybackClock;
  readonly levels?: boolean;
}) {
  const loading = new AbortController();
  const listeners = new Set<(word: SpokenWord | null) => void>();
  let words: ReadonlyArray<SpeechSynthesisWord> = [];
  const levels: SpeechSynthesisLevel[] = [];
  let estimated = false;
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
        Math.max(
          0,
          ((next.startSeconds - WORD_START_TOLERANCE_SECONDS - clock.seconds) /
            Math.max(clock.rate, 0.1)) *
            1000,
        ),
      );
  };
  const load = async () => {
    const received: SpeechSynthesisWord[] = [];
    for (;;) {
      const timings = await input.load(
        received.length,
        input.levels ? levels.length : undefined,
        loading.signal,
      );
      received.push(...timings.words);
      levels.push(...(timings.levels ?? []));
      words = received;
      if (timings.done && words.length === 0 && timings.durationSeconds) {
        words = estimateWordTimings(input.text, timings.durationSeconds);
        estimated = true;
      }
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
    /**
     * Reports the measured loudness at the playing position each meter interval, smoothed as a
     * player measuring its own audio would; returns the way to stop.
     */
    followLevels: (listener: (level: number) => void) => {
      let level = 0;
      // @effect-diagnostics-next-line globalTimers:off - Players call this outside an Effect runtime.
      const timer = setInterval(() => {
        const clock = input.clock();
        const next = smoothReadAloudLevel(
          level,
          clock.playing ? levelAt(levels, clock.seconds) : 0,
        );
        if (next !== level) listener((level = next));
      }, READ_ALOUD_LEVEL_INTERVAL_MS);
      return () => {
        clearInterval(timer);
        listener(0);
      };
    },
    /** When the word holding offset `at` starts, once its timing has arrived. */
    secondsAt: (at: number) => {
      // An estimate can land words early or late, so seeking to one skips or repeats speech.
      if (estimated) return undefined;
      const index = words.findIndex((word) => word.end > at);
      return index === -1 ? undefined : words[index]!.startSeconds;
    },
    stop: () => {
      loading.abort();
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

/** Where in the speech the word at or after markdown offset `from` starts. */
function spokenWordStart(speech: ReadAloudSpeech, from: number) {
  const at = speech.sources.findIndex((source) => source >= from);
  return at === -1 ? undefined : spokenWordAt(speech.text, at).start;
}

export function createReadAloudController(
  /** `from` is the offset in `text` where the audio should start, after a spoken lead-in. */
  prepare: (
    text: string,
    settings: ReadAloudSettings,
    signal: AbortSignal,
    from?: number,
  ) => Promise<SpeechPlayback>,
  resolve: MFunctionType = mFallback,
  /** Words for the reply's formulas when replies render them, so they are not read as TeX. */
  prepareMath: (markdown: string) => SpeakMath | undefined | Promise<SpeakMath | undefined> = () =>
    undefined,
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
  // The spoken range of the chunk `playback` speaks, and the word it is on, for seeking. Its
  // audio begins at `chunkFrom`, after any lead-in that was spoken only for context.
  let chunkStart = 0;
  let chunkFrom = 0;
  let chunkEnd = 0;
  let spokenAt = 0;
  const levelListeners = new Set<(level: number) => void>();
  let unlevel: (() => void) | null = null;
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
  // Players measure loudness only while something shows it.
  const followLevels = () => {
    unlevel?.();
    unlevel =
      playback?.levels?.((level) => {
        for (const listener of levelListeners) listener(level);
      }) ?? null;
  };
  const stopLevels = () => {
    unlevel?.();
    unlevel = null;
    for (const listener of levelListeners) listener(0);
  };
  const stopFollowing = () => {
    stopLevels();
    unfollow?.();
    unfollow = null;
    publishHighlight(null);
  };
  // What `start` reads, so a jump within the same reply reads it again with the same settings.
  let reading: {
    readonly id: string;
    readonly markdown: string;
    readonly settings: ReadAloudSettings;
    readonly words: ReadAloudWords;
  } | null = null;
  const stop = () => {
    reading = null;
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
  /**
   * Reads `markdown` aloud from the top, or from the first block that ends after markdown offset
   * `from`, such as the paragraph a user picks.
   * Speech is made only from that block on, so a jump does not wait for what comes before it.
   */
  const start = async (
    id: string,
    markdown: string,
    settings: ReadAloudSettings,
    from?: number,
    fromWord = false,
  ) => {
    // Only replies with formulas or emoji wait for their words, so others start in the same turn.
    const pendingMath = prepareMath(markdown);
    const pendingEmoji = prepareReadAloudEmoji(markdown);
    const words: ReadAloudWords = {
      math: pendingMath instanceof Promise ? await pendingMath.catch(() => undefined) : pendingMath,
      emoji: pendingEmoji && (await pendingEmoji.catch(() => undefined)),
    };
    const speech = readAloudSpeech(markdown, settings.skipCodeBlocks, words);
    const offset =
      from === undefined
        ? 0
        : fromWord
          ? spokenWordStart(speech, from)
          : readAloudBlockFrom(speech, from)?.spokenStart;
    // Nothing is read after `from`, such as in a skipped closing code block: keep reading.
    if (offset === undefined) return;
    stop();
    if (settings.provider === "off") return;
    reading = { id, markdown, settings, words };
    // Environments make speech picked up mid-sentence from the sentence's start, for context.
    // Platform engines cannot start partway into their audio, so they start at the word.
    const leadIn =
      fromWord && settings.provider !== "system"
        ? readAloudSentenceStart(speech.text, offset)
        : offset;
    // Platform speech engines cap utterance length; environments stream a whole reply.
    const chunks = splitReadAloudSpans(
      speech.text.slice(leadIn),
      settings.provider === "system" ? undefined : SPEECH_SYNTHESIS_MAX_TEXT,
    ).map((chunk) => ({ ...chunk, start: leadIn + chunk.start }));
    if (!chunks.length) return;
    const owner = new AbortController();
    active = owner;
    try {
      for (const chunk of chunks) {
        publish({ id, status: paused ? "paused" : "loading" });
        const from = Math.max(0, Math.min(offset, chunk.start + chunk.text.length) - chunk.start);
        const next = await prepare(chunk.text, settings, owner.signal, from > 0 ? from : undefined);
        if (active !== owner) {
          dispose(next);
          return;
        }
        playback = next;
        chunkStart = chunk.start;
        chunkFrom = chunk.start + from;
        chunkEnd = chunk.start + chunk.text.length;
        spokenAt = chunkFrom;
        if (next.words)
          unfollow = next.words((word) => {
            if (word) spokenAt = chunk.start + word.start;
            const position =
              word && readAloudPosition(speech, chunk.start + word.start, chunk.start + word.end);
            publishHighlight(position ? { id, ...position } : null);
          });
        if (levelListeners.size) followLevels();
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
  };
  const isReading = (id: string) =>
    reading?.id === id && state.status !== "idle" && state.status !== "error";
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
    start,
    /** Whether message `id` is being read, paused, or made into speech. */
    isReading,
    /**
     * While message `id` is being read, reads it again from markdown offset `from` with the same
     * settings; null when it is not being read.
     */
    jump(id: string, from: number) {
      return reading && isReading(id) ? start(id, reading.markdown, reading.settings, from) : null;
    },
    /**
     * While message `id` is being read, moves to the word at markdown offset `from`: within the
     * audio when its time is known, otherwise by reading again from that word. Null when `id` is
     * not being read.
     */
    seek(id: string, from: number) {
      if (!reading || !isReading(id)) return null;
      const speech = readAloudSpeech(
        reading.markdown,
        reading.settings.skipCodeBlocks,
        reading.words,
      );
      const at = spokenWordStart(speech, from);
      if (at === undefined) return null;
      if (at >= chunkFrom && at < chunkEnd && playback?.seek?.(at - chunkStart))
        return Promise.resolve();
      return start(id, reading.markdown, reading.settings, from, true);
    },
    /** Reads on at `speed`; players that cannot change rate read again from the current word. */
    setSpeed(speed: number) {
      if (!reading) return null;
      const current = reading;
      reading = { ...current, settings: { ...current.settings, speed } };
      if (playback?.setSpeed) {
        playback.setSpeed(speed);
        return Promise.resolve();
      }
      const speech = readAloudSpeech(
        current.markdown,
        current.settings.skipCodeBlocks,
        current.words,
      );
      const from = speech.sources.slice(spokenAt).find((source) => source >= 0);
      return from === undefined
        ? null
        : start(current.id, current.markdown, reading.settings, from, true);
    },
    /** How loud the reply being read is, from 0 to 1, while it plays. */
    subscribeLevel(listener: (level: number) => void) {
      levelListeners.add(listener);
      if (levelListeners.size === 1) followLevels();
      return () => {
        levelListeners.delete(listener);
        if (levelListeners.size) return;
        unlevel?.();
        unlevel = null;
      };
    },
  };
}
