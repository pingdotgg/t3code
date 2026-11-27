// @effect-diagnostics nodeBuiltinImport:off - lamejs loads from disk outside the bundle.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// lamejs stays external, and single-executables cannot import disk packages. Its `require`
// entry is an IIFE that exports nothing, so import its ES module by path instead.
let lamejs: Promise<typeof import("@breezystack/lamejs")> | undefined;
const loadLamejs = () =>
  (lamejs ??= (async () => {
    const packagePath = NodeModule.findPackageJSON("@breezystack/lamejs", import.meta.url);
    if (!packagePath) throw new Error("The MP3 encoder package is unavailable.");
    const { module } = JSON.parse(await NodeFSP.readFile(packagePath, "utf8"));
    const entry = NodePath.join(NodePath.dirname(packagePath), module);
    return import(NodeURL.pathToFileURL(entry).href);
  })());

export const MAX_SYNTHESIS_BYTES = 32 * 1024 * 1024;

/**
 * The lowest bitrate at which LAME keeps the input rate: lamejs's resampler turns speech into
 * near-silence. Self-contained so the synthesis worker can inline it with `toString()`.
 */
export function mp3Kbps(sampleRate: number) {
  return sampleRate > 32000 ? 64 : 48;
}
/**
 * The lines of read-aloud text, one sentence or block each, spoken one at a time as Kokoro's
 * reference pipeline splits them, so the first arrives before the model reaches the rest.
 * Self-contained so the synthesis worker can inline it.
 */
/** The lines of `text` with words in them, and where each sits in `text`. */
export function speechLineSpans(text: string) {
  return [...text.matchAll(/[^\n]+/g)]
    .filter((line) => line[0].trim())
    .map((line) => ({ text: line[0], start: line.index, end: line.index + line[0].length }));
}

export function speechLines(text: string) {
  return text.split(/\n+/).filter((line) => line.trim());
}

/**
 * Halves `text` at its last sentence end before the middle, else clause, else comma, for a model
 * that refused it as too long: the waterfall Kokoro's reference pipeline uses to stay under 510
 * phonemes. Undefined when there is no such break. Self-contained so the worker can inline it.
 */
export function splitAtPunctuation(text: string) {
  const middle = Math.floor(text.length / 2);
  for (const marks of [/[!.?…]\s/g, /[:;]\s/g, /[,—]\s/g, /\s/g]) {
    const breaks = [...text.matchAll(marks)].map((match) => match.index + match[0].length);
    const at = breaks.filter((index) => index <= middle).at(-1) ?? breaks[0];
    if (at !== undefined && at > 0 && at < text.length) return [text.slice(0, at), text.slice(at)];
  }
  return undefined;
}

// Supertonic's reference text preprocessing (supertone-inc/supertonic `py/helper.py`): its
// indexer has no entry for emoji and some symbols, and rejects the whole text over one.
const SUPERTONIC_EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}/gu;
const SUPERTONIC_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[–‑—]/g, "-"],
  [/_/g, " "],
  [/[“”]/g, '"'],
  [/[‘’´`]/g, "'"],
  [/[[\]|/#→←]/g, " "],
  [/[♥☆♡©\\]/g, ""],
  [/@/g, " at "],
  [/\be\.g\.,/g, "for example,"],
  [/\bi\.e\.,/g, "that is,"],
];

/** Text Supertonic can speak, cleaned the way its reference implementation cleans it. */
export function supertonicText(text: string) {
  let cleaned = text.normalize("NFKD").replace(SUPERTONIC_EMOJI, "");
  for (const [pattern, replacement] of SUPERTONIC_REPLACEMENTS)
    cleaned = cleaned.replace(pattern, replacement);
  return cleaned
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+([,.!?;:'])/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .join("\n");
}
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
// About half a second at 44.1 kHz, which encodes in about 15 ms.
export const ENCODE_SLICE_SAMPLES = 1152 * 20;

/**
 * Downmixes to mono 16-bit PCM, clipping out-of-range and non-finite samples.
 * Self-contained so the synthesis worker can inline it with `toString()`.
 */
export function pcm16Mono(samples: Float32Array, channels: number) {
  const pcm = new Int16Array(Math.floor(samples.length / channels));
  for (let frame = 0; frame < pcm.length; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++)
      sum += samples[frame * channels + channel]!;
    const sample = Math.max(-1, Math.min(1, sum / channels || 0));
    pcm[frame] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

/** Whether `encodeMp3` takes this little-endian 16-bit PCM. */
function isEncodablePcm(pcm: Uint8Array, rate: number, channels: number) {
  return (
    MP3_SAMPLE_RATES.includes(rate) &&
    (channels === 1 || channels === 2) &&
    pcm.length > 0 &&
    pcm.length % (channels * 2) === 0 &&
    pcm.length <= MAX_SYNTHESIS_BYTES
  );
}

/** Whether MP3 can carry PCM at this rate and channel count unchanged. */
/**
 * The samples of a 16-bit PCM WAV, such as a voice clip. The synthesis worker inlines it, so it
 * references nothing outside itself.
 */
export function wavAudio(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === "data") {
      if (bits !== 16 || !channels) throw new Error("Voice clips must be 16-bit PCM WAV.");
      const samples = new Float32Array(Math.floor(Math.min(size, bytes.length - at - 8) / 2));
      for (let index = 0; index < samples.length; index++)
        samples[index] = view.getInt16(at + 8 + index * 2, true) / 0x8000;
      return { samples, sampleRate, channels };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("The voice clip has no audio.");
}

/**
 * Turns down peaks above `ceiling` smoothly instead of clipping them, which sounds like a pop.
 * Several local models overshoot full scale, most of all at the start of a call. It holds back
 * the last few milliseconds of each part to see the peaks ahead, so call `flush` after the last
 * part of a reply. The synthesis worker inlines it, so it references nothing outside itself.
 */
export function peakLimiter(sampleRate: number, channels: number, ceiling = 0.89) {
  const span = Math.max(1, Math.round(sampleRate * 0.005));
  const release = 1 - Math.exp(-1 / (sampleRate * 0.15));
  // Starts with a span of silence, so even a peak at the very start ramps down in time.
  let held = new Float32Array(span * channels);
  // The targets of the last frames out, so a ramp continues across parts.
  let recent: number[] = Array.from({ length: span }, () => 1);
  let gain = 1;
  const run = (input: Float32Array, final: boolean) => {
    const samples = new Float32Array(held.length + input.length);
    samples.set(held);
    samples.set(input, held.length);
    const frames = Math.floor(samples.length / channels);
    const ready = final ? frames : Math.max(0, frames - span);
    const needed = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      let peak = 0;
      for (let channel = 0; channel < channels; channel++)
        peak = Math.max(peak, Math.abs(samples[frame * channels + channel]! || 0));
      needed[frame] = peak > ceiling ? ceiling / peak : 1;
    }
    // Each frame's target is the lowest gain due within the next span; averaging the targets
    // over the last span ramps the gain down to each peak's by the time the peak plays.
    const ahead = new Float32Array(frames);
    const window: number[] = [];
    for (let frame = frames - 1; frame >= 0; frame--) {
      while (window.length && needed[window.at(-1)!]! >= needed[frame]!) window.pop();
      window.push(frame);
      if (window[0]! >= frame + span) window.shift();
      ahead[frame] = needed[window[0]!]!;
    }
    const targets = [...recent, ...ahead.subarray(0, ready)];
    let sum = recent.reduce((total, target) => total + target, 0);
    const out = new Float32Array(ready * channels);
    for (let frame = 0; frame < ready; frame++) {
      sum += targets[span + frame]! - targets[frame]!;
      const ramp = sum / span;
      gain = ramp < gain ? ramp : gain + (ramp - gain) * release;
      for (let channel = 0; channel < channels; channel++)
        out[frame * channels + channel] = samples[frame * channels + channel]! * gain;
    }
    recent = targets.slice(ready);
    held = samples.slice(ready * channels);
    return out;
  };
  return {
    limit: (samples: Float32Array) => run(samples, false),
    flush: () => run(new Float32Array(0), true),
  };
}

export function isEncodableFormat(rate: number, channels: number) {
  return MP3_SAMPLE_RATES.includes(rate) && (channels === 1 || channels === 2);
}

/**
 * Encodes little-endian 16-bit PCM to MP3 as it arrives, so audio plays before the provider
 * finishes. Network chunks can split a sample or frame; the remainder waits for the next one.
 */
export async function streamingMp3Encoder(rate: number, channels: number) {
  const { Mp3Encoder } = await loadLamejs();
  const encoder = new Mp3Encoder(1, rate, mp3Kbps(rate));
  const frame = channels * 2;
  let pending = new Uint8Array(0);
  return {
    /** The mono samples of whole frames received so far, and their MP3. */
    push: (bytes: Uint8Array) => {
      const joined = pending.length ? concat([pending, bytes]) : bytes;
      const whole = joined.length - (joined.length % frame);
      pending = joined.slice(whole);
      const pcm = monoPcm16(joined.subarray(0, whole), channels);
      const parts: Uint8Array[] = [];
      for (let start = 0; start < pcm.length; start += ENCODE_SLICE_SAMPLES)
        parts.push(encoder.encodeBuffer(pcm.subarray(start, start + ENCODE_SLICE_SAMPLES)));
      return { pcm, mp3: concat(parts) };
    },
    flush: () => concat([encoder.flush()]),
  };
}

/** Little-endian 16-bit PCM bytes as mono samples. */
function monoPcm16(pcm: Uint8Array, channels: number) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  return pcm16Mono(samples, channels);
}

/** Encodes little-endian 16-bit PCM to MP3 in slices, so a long clip never holds the event loop. */
export function encodeMp3(
  pcm: Uint8Array,
  rate: number,
  channels = 1,
): Stream.Stream<Uint8Array, Error> {
  if (!isEncodablePcm(pcm, rate, channels)) return Stream.fail(new Error("Invalid speech audio."));
  const mono = monoPcm16(pcm, channels);
  const slices = Math.ceil(mono.length / ENCODE_SLICE_SAMPLES);
  // A missing encoder package is a packaging defect, not a recoverable failure.
  return Effect.promise(loadLamejs).pipe(
    Effect.map(({ Mp3Encoder }) => {
      const encoder = new Mp3Encoder(1, rate, mp3Kbps(rate));
      return Stream.range(0, slices - 1).pipe(
        Stream.mapEffect((slice) =>
          Effect.sync(() => {
            const start = slice * ENCODE_SLICE_SAMPLES;
            const parts = [
              encoder.encodeBuffer(mono.subarray(start, start + ENCODE_SLICE_SAMPLES)),
            ];
            if (slice === slices - 1) parts.push(encoder.flush());
            return concat(parts);
          }).pipe(Effect.tap(() => Effect.yieldNow)),
        ),
      );
    }),
    Stream.unwrap,
    Stream.filter((bytes) => bytes.length > 0),
  );
}

// lamejs returns Int8Array despite its types; copying into Uint8Array keeps byte values unsigned.
function concat(parts: readonly Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
