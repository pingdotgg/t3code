const SAMPLES_PER_MS = 16;
/** A listening sound that runs longer than this is a turn, not a backchannel. */
const BACKCHANNEL_MAX_SAMPLES = 1200 * SAMPLES_PER_MS;
/** Words the voice played this recently can come back through the mic as echo. */
export const ECHO_WINDOW_SAMPLES = 2500 * SAMPLES_PER_MS;
const SETTLED_SAMPLES = 300 * SAMPLES_PER_MS;

const BACKCHANNELS = [
  "mm hm",
  "mhm",
  "mm",
  "uh huh",
  "yeah",
  "yep",
  "yes",
  "okay",
  "ok",
  "got it",
  "right",
  "sure",
  "i see",
  "alright",
  "all right",
  "cool",
].map((phrase) => phrase.split(" "));

/** Lowercase words without punctuation, so transcripts and spoken text compare. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function backchannelMatch(heard: readonly string[]) {
  // "yeah yeah" and "okay okay" are still one listening sound.
  const deduped = heard.filter((word, index) => word !== heard[index - 1]);
  let prefix = false;
  for (const phrase of BACKCHANNELS) {
    if (deduped.length > phrase.length) continue;
    if (!deduped.every((word, index) => word === phrase[index])) continue;
    if (deduped.length === phrase.length) return "whole";
    prefix = true;
  }
  return prefix ? "prefix" : "none";
}

export function isBackchannel(text: string) {
  return backchannelMatch(words(text)) === "whole";
}

/** True when every word heard was also played lately, so it is likely the voice's own echo. */
export function heardOnlyEcho(text: string, echo: ReadonlySet<string>) {
  const heard = words(text);
  return heard.length > 0 && heard.every((word) => echo.has(word));
}

export type Interruption = "pending" | "echo" | "backchannel" | "turn";

/**
 * Judges speech that started while the voice was speaking. Positions are samples of the
 * current utterance: `start` where the interrupting speech began, `voicedUntil` where it
 * last ended, `samples` how far the mic has been heard.
 */
export function classifyInterruption(input: {
  readonly text: string;
  readonly start: number;
  readonly voicedUntil: number | undefined;
  readonly samples: number;
  readonly echo: ReadonlySet<string>;
}): Interruption {
  const heard = words(input.text);
  const fresh = heard.filter((word) => !input.echo.has(word));
  const match = backchannelMatch(heard);
  if (fresh.length > 0 && match === "none") return "turn";
  const end = input.voicedUntil ?? input.samples;
  if (end - input.start > BACKCHANNEL_MAX_SAMPLES && fresh.length > 0) return "turn";
  if (input.samples - end < SETTLED_SAMPLES) return "pending";
  if (fresh.length === 0) return "echo";
  return match === "whole" && end - input.start <= BACKCHANNEL_MAX_SAMPLES ? "backchannel" : "turn";
}

/** One rendered piece of a spoken text; `end` is its last sample within the utterance. */
export type SpokenSentence = { readonly text: string; readonly end?: number };

/**
 * Splits spoken text at a playback cursor into the words already heard and the rest.
 * Within a sentence, words count as played in proportion to their characters.
 */
export function splitAtCursor(sentences: readonly SpokenSentence[], sample: number) {
  const played: string[] = [];
  const rest: string[] = [];
  let start = 0;
  for (const sentence of sentences) {
    const pieces = sentence.text.split(/\s+/).filter(Boolean);
    if (sentence.end === undefined || sample <= start) rest.push(...pieces);
    else if (sample >= sentence.end) played.push(...pieces);
    else {
      const total = pieces.reduce((sum, word) => sum + word.length, 0);
      const heard = ((sample - start) / (sentence.end - start)) * total;
      let through = 0;
      for (const word of pieces) {
        through += word.length;
        (through <= heard ? played : rest).push(word);
      }
    }
    if (sentence.end !== undefined) start = sentence.end;
  }
  return { played: played.join(" "), rest: rest.join(" ") };
}
