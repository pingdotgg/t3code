import { Mp3Encoder } from "@breezystack/lamejs";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const MAX_SYNTHESIS_BYTES = 32 * 1024 * 1024;

/**
 * The lowest bitrate at which LAME keeps the input rate: lamejs's resampler turns speech into
 * near-silence. Self-contained so the synthesis worker can inline it with `toString()`.
 */
export function mp3Kbps(sampleRate: number) {
  return sampleRate > 32000 ? 64 : 48;
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

/** Encodes little-endian 16-bit PCM to MP3 in slices, so a long clip never holds the event loop. */
export function encodeMp3(
  pcm: Uint8Array,
  rate: number,
  channels = 1,
): Stream.Stream<Uint8Array, Error> {
  if (
    !MP3_SAMPLE_RATES.includes(rate) ||
    (channels !== 1 && channels !== 2) ||
    !pcm.length ||
    pcm.length % (channels * 2) ||
    pcm.length > MAX_SYNTHESIS_BYTES
  )
    return Stream.fail(new Error("Invalid speech audio."));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  const mono = pcm16Mono(samples, channels);
  const encoder = new Mp3Encoder(1, rate, mp3Kbps(rate));
  const slices = Math.ceil(mono.length / ENCODE_SLICE_SAMPLES);
  return Stream.range(0, slices - 1).pipe(
    Stream.mapEffect((slice) =>
      Effect.sync(() => {
        const start = slice * ENCODE_SLICE_SAMPLES;
        const parts = [encoder.encodeBuffer(mono.subarray(start, start + ENCODE_SLICE_SAMPLES))];
        if (slice === slices - 1) parts.push(encoder.flush());
        return concat(parts);
      }).pipe(Effect.tap(() => Effect.yieldNow)),
    ),
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
