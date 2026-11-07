const SAMPLES_PER_MS = 16;
const SPEECH_START_GAP_MS = 300;
const FINISHED = /[.!?]["')\]]*$/;
const UNFINISHED = /(?:,|\b(?:and|so|but|or|because|the|a|an|to|of|with|then))$/i;

export type TurnSettings = {
  /** Pause after a finished sentence. */
  readonly finishedSilenceMs: number;
  readonly endSilenceMs: number;
  /** Pause after text that reads as unfinished, such as a trailing comma or "and". */
  readonly endSilenceLongMs: number;
  readonly maxUtteranceMs: number;
};

// Streaming Parakeet adds a sentence's period only once the next sentence starts,
// so the plain pause, not the finished-sentence one, ends most turns.
export const DEFAULT_TURN_SETTINGS: TurnSettings = {
  finishedSilenceMs: 800,
  endSilenceMs: 1500,
  endSilenceLongMs: 3000,
  maxUtteranceMs: 120_000,
};

export type TurnObservation = {
  /** Samples fed since the utterance began. */
  readonly samples: number;
  /** Sample where speech last ended, or undefined while none was heard or without a detector. */
  readonly voicedUntil: number | undefined;
  readonly text: string;
};

export function requiredSilenceMs(text: string, settings: TurnSettings) {
  const words = text.trim();
  if (FINISHED.test(words)) return settings.finishedSilenceMs;
  if (UNFINISHED.test(words)) return settings.endSilenceLongMs;
  return settings.endSilenceMs;
}

/** Decides utterance ends from audio position, so it never reads a clock. */
export function makeTurnDetector(settings: TurnSettings = DEFAULT_TURN_SETTINGS) {
  let heardUntil: number | undefined;
  let lastSamples = 0;
  let lastText = "";
  return {
    observe({ samples, voicedUntil, text }: TurnObservation) {
      const previous = heardUntil;
      // Without a silence detector, the last change in the transcript stands in for speech.
      const current = voicedUntil ?? (text !== lastText ? samples : heardUntil);
      const heard = current !== undefined && current !== previous;
      const speechStarted =
        heard &&
        (previous === undefined || lastSamples - previous >= SPEECH_START_GAP_MS * SAMPLES_PER_MS);
      heardUntil = current;
      lastSamples = samples;
      lastText = text;
      const ended =
        text.trim() !== "" &&
        (samples >= settings.maxUtteranceMs * SAMPLES_PER_MS ||
          (current !== undefined &&
            samples - current >= requiredSilenceMs(text, settings) * SAMPLES_PER_MS));
      return { heard, speechStarted, ended };
    },
    reset() {
      heardUntil = undefined;
      lastSamples = 0;
      lastText = "";
    },
  };
}
