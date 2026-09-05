// Bounded streaming leading-silence removal for Pocket PCM output.
//
// The native decoder often starts with near-silence before audible speech.
// This gate drops only that leading prefix: it waits for a short RMS window
// to cross the threshold, keeps a small preroll so quiet word starts survive,
// caps how much can be removed, and passes every later sample through,
// including pauses inside the utterance.
//
// Ported from the measured onset study. Unit tests prove the filter returns
// an exact suffix across variable chunk boundaries.
import {
  pocketOnsetMaxTrimMs,
  pocketOnsetPrerollMs,
  pocketOnsetThresholdDbfs,
  pocketOnsetWindowMs,
  pocketSampleRate,
} from "./pocket-config.ts";

export type PocketOnsetFilter = {
  readonly push: (chunk: Float32Array) => Float32Array | undefined;
  readonly finish: () => Float32Array;
  readonly droppedSamples: () => number;
};

export function createPocketOnsetFilter(
  input: {
    readonly sampleRate?: number;
    readonly thresholdDbfs?: number;
    readonly windowMs?: number;
    readonly prerollMs?: number;
    readonly maxTrimMs?: number;
  } = {},
): PocketOnsetFilter {
  const sampleRate = input.sampleRate ?? pocketSampleRate;
  const window = Math.max(
    1,
    Math.round((sampleRate * (input.windowMs ?? pocketOnsetWindowMs)) / 1000),
  );
  const preroll = Math.round((sampleRate * (input.prerollMs ?? pocketOnsetPrerollMs)) / 1000);
  const limit = Math.round((sampleRate * (input.maxTrimMs ?? pocketOnsetMaxTrimMs)) / 1000);
  const threshold = 10 ** ((input.thresholdDbfs ?? pocketOnsetThresholdDbfs) / 20);
  let pending = new Float32Array(0);
  let open = false;
  let seen = 0;
  let dropped = 0;

  const concatenated = (chunk: Float32Array): Float32Array => {
    if (pending.length === 0) return chunk;
    const values = new Float32Array(pending.length + chunk.length);
    values.set(pending, 0);
    values.set(chunk, pending.length);
    return values;
  };

  const push = (chunk: Float32Array): Float32Array | undefined => {
    if (open) return chunk;
    if (chunk.length === 0) return undefined;
    seen += chunk.length;
    const values = concatenated(chunk);
    if (values.length >= window) {
      let squares = 0;
      for (let index = 0; index < window; index += 1) {
        const sample = values[index] ?? 0;
        squares += sample * sample;
      }
      let audibleAt = squares / window >= threshold * threshold ? 0 : -1;
      if (audibleAt === -1) {
        for (let start = 1; start + window <= values.length; start += 1) {
          const leaving = values[start - 1] ?? 0;
          const entering = values[start + window - 1] ?? 0;
          squares += entering * entering - leaving * leaving;
          if (squares / window >= threshold * threshold) {
            audibleAt = start;
            break;
          }
        }
      }
      if (audibleAt !== -1) {
        const start = Math.max(0, audibleAt - preroll);
        dropped += start;
        open = true;
        pending = new Float32Array(0);
        return values.slice(start);
      }
    }
    if (seen >= limit) {
      open = true;
      pending = new Float32Array(0);
      return values;
    }
    const keep = Math.min(values.length, preroll + window);
    dropped += values.length - keep;
    pending = values.slice(values.length - keep);
    return undefined;
  };

  const finish = (): Float32Array => {
    const values = pending;
    pending = new Float32Array(0);
    return values;
  };

  return { push, finish, droppedSamples: () => dropped };
}
