import type { SpeechSynthesisWord } from "@t3tools/contracts";

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_RATES = [44100, 48000, 32000];

/** Layer III frame length and duration at `at`, or undefined when no frame header starts there. */
function frameAt(bytes: Uint8Array, at: number) {
  const [sync, flags, info] = [bytes[at], bytes[at + 1], bytes[at + 2]];
  if (sync !== 0xff || flags === undefined || info === undefined || (flags & 0xe0) !== 0xe0)
    return undefined;
  const version = (flags >> 3) & 3;
  if (version === 1 || ((flags >> 1) & 3) !== 1) return undefined;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[info >> 4];
  const base = MPEG1_RATES[(info >> 2) & 3];
  if (!kbps || base === undefined) return undefined;
  const rate = mpeg1 ? base : version === 2 ? base / 2 : base / 4;
  const samples = mpeg1 ? 1152 : 576;
  return {
    length: Math.floor(((samples / 8) * kbps * 1000) / rate) + ((info >> 1) & 1),
    seconds: samples / rate,
  };
}

// Players keep lame's encoder delay at the start of each MP3 stream the PCM becomes.
export const MP3_ENCODER_DELAY_SAMPLES = 1105;

/** Mono PCM a synthesis sent, starting `startSeconds` into its MP3, before the encoder delay. */
export type TimedPcm = {
  readonly pcm: Int16Array;
  readonly rate: number;
  readonly startSeconds: number;
};

/**
 * The middle of the latest of the quietest 20 ms stretches of `parts` between `from` and `to`
 * seconds of MP3 time, where a cut is least likely to catch a word; undefined when the PCM does
 * not cover that span. Of stretches about as quiet, the latest sits closest to the next word.
 */
export function quietestMoment(parts: ReadonlyArray<TimedPcm>, from: number, to: number) {
  const stretches: Array<{ readonly seconds: number; readonly level: number }> = [];
  for (const { pcm, rate, startSeconds } of parts) {
    const offset = startSeconds + MP3_ENCODER_DELAY_SAMPLES / rate;
    const window = Math.max(1, Math.round(rate * 0.02));
    const hop = Math.max(1, Math.round(rate * 0.005));
    const last = Math.min(pcm.length, Math.floor((to - offset) * rate)) - window;
    for (let start = Math.max(0, Math.ceil((from - offset) * rate)); start <= last; start += hop) {
      let energy = 0;
      for (let index = start; index < start + window; index++) energy += pcm[index]! ** 2;
      stretches.push({
        seconds: offset + (start + window / 2) / rate,
        level: Math.sqrt(energy / window),
      });
    }
  }
  if (!stretches.length) return undefined;
  const quietest = Math.min(...stretches.map((stretch) => stretch.level));
  // Twice as loud, or under about -50 dBFS, still reads as quiet.
  const quiet = Math.max(quietest * 2, 100);
  return stretches.findLast((stretch) => stretch.level <= quiet)!.seconds;
}

/**
 * The frame of an MP3 stream that plays at `seconds`: its byte offset and when it starts, or
 * undefined until `bytes` reach it. Audio cut there decodes from a frame boundary. `end` is
 * where the next frame starts.
 */
export function mp3FrameAt(bytes: Uint8Array, seconds: number) {
  // An ID3v2 tag holds metadata, not audio; its size is four 7-bit bytes.
  let at =
    bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10
      ? 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!)
      : 0;
  let elapsed = 0;
  while (at + 4 <= bytes.length) {
    const frame = frameAt(bytes, at);
    if (!frame) {
      at++;
      continue;
    }
    if (at + frame.length > bytes.length) return undefined;
    if (elapsed + frame.seconds > seconds)
      return {
        offset: at,
        seconds: elapsed,
        end: { offset: at + frame.length, seconds: elapsed + frame.seconds },
      };
    elapsed += frame.seconds;
    at += frame.length;
  }
  return undefined;
}

/**
 * Counts the playing time of an MP3 stream from its frame headers as chunks arrive. Word timings
 * of later synthesis pieces start where the earlier pieces' audio ends.
 */
export function mp3Duration() {
  let carry = new Uint8Array(0);
  let skip = 0;
  let started = false;
  let seconds = 0;
  return {
    push(chunk: Uint8Array) {
      let bytes = new Uint8Array(carry.length + chunk.length);
      bytes.set(carry);
      bytes.set(chunk, carry.length);
      if (!started) {
        if (bytes.length < 10) {
          carry = bytes;
          return;
        }
        started = true;
        // An ID3v2 tag holds metadata, not audio; its size is four 7-bit bytes.
        if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
          skip = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
      }
      const skipped = Math.min(skip, bytes.length);
      skip -= skipped;
      bytes = bytes.subarray(skipped);
      let at = 0;
      while (at + 4 <= bytes.length) {
        const frame = frameAt(bytes, at);
        if (!frame) {
          at++;
          continue;
        }
        if (at + frame.length > bytes.length) break;
        seconds += frame.seconds;
        at += frame.length;
      }
      carry = bytes.slice(at);
    },
    get seconds() {
      return seconds;
    },
  };
}

export interface CharacterAlignment {
  readonly characters: ReadonlyArray<string>;
  readonly character_start_times_seconds: ReadonlyArray<number>;
  readonly character_end_times_seconds: ReadonlyArray<number>;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * Turns streamed character alignment for `text` into words. Each alignment entry is one code
 * point; offsets become UTF-16. Once the characters stop matching `text` no more words come,
 * since a wrong highlight is worse than none.
 */
export function alignedWords(text: string) {
  let offset = 0;
  let matching = true;
  let open: SpeechSynthesisWord | null = null;
  let voiced = false;
  const close = (words: SpeechSynthesisWord[]) => {
    // Emoji are aligned with zero duration because they are not spoken.
    if (open && voiced) words.push(open);
    open = null;
    voiced = false;
  };
  return {
    push(alignment: CharacterAlignment) {
      const words: SpeechSynthesisWord[] = [];
      alignment.characters.forEach((character, index) => {
        const startSeconds = alignment.character_start_times_seconds[index];
        const endSeconds = alignment.character_end_times_seconds[index];
        if (!matching) return;
        if (
          startSeconds === undefined ||
          endSeconds === undefined ||
          !text.startsWith(character, offset)
        ) {
          matching = false;
          open = null;
          return;
        }
        if (/^\s+$/u.test(character)) close(words);
        else {
          open = {
            start: open ? open.start : offset,
            end: offset + character.length,
            startSeconds: open ? open.startSeconds : round(startSeconds),
            endSeconds: round(endSeconds),
          };
          if (endSeconds > startSeconds) voiced = true;
        }
        offset += character.length;
      });
      return words;
    },
    end() {
      const words: SpeechSynthesisWord[] = [];
      if (matching && offset === text.length) close(words);
      return words;
    },
  };
}
