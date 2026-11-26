import { SPEECH_SYNTHESIS_LEVEL_STEPS } from "@t3tools/contracts";

import { mp3Frames, type Mp3Frame } from "./synthesisTimings.ts";

/** Seconds of audio each level covers. */
export const SPEECH_LEVEL_WINDOW_SECONDS = 0.05;
// The meter scale clients use for audio they sample themselves.
const SILENCE_DECIBELS = -50;
const PEAK_DECIBELS = -10;
// LAME's encoder delay: the MP3 players hear starts this many samples after its PCM.
const ENCODER_DELAY_SAMPLES = 576 + 529;
// MP3 global gains of speech span about this much between pauses and loud words.
const MIN_GAIN_SPAN = 12;

/** How loud audio of this mean-square power (samples -1 to 1) is, from 0 to 1. */
export function powerLevel(power: number) {
  if (!(power > 0)) return 0;
  const decibels = 10 * Math.log10(power);
  return Math.min(
    1,
    Math.max(0, (decibels - SILENCE_DECIBELS) / (PEAK_DECIBELS - SILENCE_DECIBELS)),
  );
}

/**
 * The global gain of each granule of a Layer III frame, averaged over its channels, from the side
 * information after the header. A louder granule is quantized with a larger step, so its gain
 * follows loudness without decoding the audio. `undefined` marks a granule with no coded audio.
 */
function mp3GranuleGains(bytes: Uint8Array, frame: Mp3Frame) {
  let bit = (4 + (frame.crc ? 2 : 0)) * 8;
  const read = (bits: number) => {
    let value = 0;
    for (let index = 0; index < bits; index++, bit++)
      value = (value << 1) | (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    return value;
  };
  const mono = frame.channels === 1;
  // main_data_begin, private bits, and MPEG-1's scale factor selection.
  if (frame.mpeg1) read(9 + (mono ? 5 : 3) + frame.channels * 4);
  else read(8 + (mono ? 1 : 2));
  const gains: Array<number | undefined> = [];
  for (let granule = 0; granule < (frame.mpeg1 ? 2 : 1); granule++) {
    let sum = 0;
    let coded = 0;
    for (let channel = 0; channel < frame.channels; channel++) {
      const bits = read(12);
      read(9);
      const gain = read(8);
      // Scale factor compression, block settings, and the table and scale flags.
      read(frame.mpeg1 ? 4 + 1 + 22 + 3 : 9 + 1 + 22 + 2);
      if (bits > 0) {
        sum += gain;
        coded++;
      }
    }
    gains.push(coded ? sum / coded : undefined);
  }
  return gains;
}

type Window = { sum: number; count: number; coded: number };

/**
 * Loudness per `SPEECH_LEVEL_WINDOW_SECONDS` of a synthesis' audio. PCM is measured exactly;
 * MP3-only audio is estimated from its frames' global gains, scaled to the stream's own range.
 * PCM wins when a provider sends both. When `held`, none count until `start` says where the
 * audio played starts.
 */
export function speechLevels(held = false) {
  let source: "pcm" | "mp3" | undefined;
  // The first window of the audio played; `undefined` while held.
  let origin: number | undefined = held ? undefined : 0;
  let windows: Window[] = [];
  let end = 0;
  let finished = false;
  // Counts of coded granules per global gain, for the stream's quiet and loud gains.
  const gainCounts = new Uint32Array(256);
  let gainTotal = 0;
  const window = (index: number) => {
    for (let at = windows.length; at <= index; at++) windows.push({ sum: 0, count: 0, coded: 0 });
    return windows[index]!;
  };
  const frames = mp3Frames((bytes, frame, startSeconds) => {
    const gains = mp3GranuleGains(bytes, frame);
    const seconds = frame.seconds / gains.length;
    gains.forEach((gain, granule) => {
      const middle = startSeconds + (granule + 0.5) * seconds;
      const target = window(Math.floor(middle / SPEECH_LEVEL_WINDOW_SECONDS));
      target.count++;
      if (gain === undefined) return;
      target.sum += gain;
      target.coded++;
      gainCounts[Math.round(gain)]!++;
      gainTotal++;
    });
    end = startSeconds + frame.seconds;
  });
  const gainAt = (fraction: number) => {
    let seen = 0;
    for (let gain = 0; gain < gainCounts.length; gain++) {
      seen += gainCounts[gain]!;
      if (seen > fraction * (gainTotal - 1)) return gain;
    }
    return gainCounts.length - 1;
  };
  const level = (entry: Window | undefined) => {
    if (!entry?.count) return 0;
    if (source === "pcm") return powerLevel(entry.sum / entry.count);
    if (!entry.coded) return 0;
    const quiet = gainAt(0.1);
    const span = Math.max(MIN_GAIN_SPAN, gainAt(0.95) - quiet);
    const loudness = Math.min(1, Math.max(0, (entry.sum / entry.coded - quiet) / span));
    return (loudness * entry.coded) / entry.count;
  };
  const count = () => {
    if (origin === undefined) return 0;
    const windowsSoFar = end / SPEECH_LEVEL_WINDOW_SECONDS;
    const measured = finished ? Math.ceil(windowsSoFar - 1e-9) : Math.floor(windowsSoFar + 1e-9);
    return Math.max(0, measured - origin);
  };
  return {
    /** Mono PCM starting `startSeconds` into the audio, before it was encoded to MP3. */
    pushPcm(pcm: Int16Array, rate: number, startSeconds: number) {
      if (source !== "pcm") {
        source = "pcm";
        windows = [];
        end = 0;
      }
      const start = startSeconds + ENCODER_DELAY_SAMPLES / rate;
      for (let index = 0; index < pcm.length; index++) {
        const target = window(Math.floor((start + index / rate) / SPEECH_LEVEL_WINDOW_SECONDS));
        const sample = pcm[index]! / 0x8000;
        target.sum += sample * sample;
        target.count++;
      }
      end = Math.max(end, start + pcm.length / rate);
    },
    /** MP3 bytes of the whole stream in order; ignored once PCM has arrived. */
    pushMp3(chunk: Uint8Array) {
      if (source === "pcm") return;
      source = "mp3";
      frames.push(chunk);
    },
    /** The audio played starts `seconds` into the synthesis; earlier levels are dropped. */
    start(seconds: number) {
      origin = Math.round(seconds / SPEECH_LEVEL_WINDOW_SECONDS);
    },
    /** The audio has ended, so its last partial window counts too. */
    finish() {
      finished = true;
    },
    /** How many windows are measured; later audio no longer changes them. */
    get count() {
      return count();
    },
    /** Levels in whole steps up to `SPEECH_SYNTHESIS_LEVEL_STEPS`, from window `from`. */
    slice(from: number) {
      const values: number[] = [];
      const first = origin ?? 0;
      for (let index = from; index < count(); index++)
        values.push(Math.round(level(windows[first + index]) * SPEECH_SYNTHESIS_LEVEL_STEPS));
      return values;
    },
  };
}
