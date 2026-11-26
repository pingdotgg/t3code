/** Quieter than this reads as silence; this loud or louder fills the meter. */
const SILENCE_DECIBELS = -50;
const PEAK_DECIBELS = -10;
const LEVELS_PER_SECOND = 15;
/** How often the meter reads the environment's levels while audio plays. */
export const SPEECH_LEVEL_INTERVAL_MS = 80;

type AudioChannels = ReadonlyArray<{ readonly frames: ReadonlyArray<number> }>;

/** How loud a buffer of PCM frames (-1 to 1) is, from 0 to 1: its RMS on a decibel scale. */
export function audioSampleLevel(channels: AudioChannels) {
  let sum = 0;
  let count = 0;
  for (const channel of channels)
    for (const frame of channel.frames) {
      sum += frame * frame;
      count++;
    }
  if (count === 0) return 0;
  const decibels = 10 * Math.log10(sum / count);
  const level = (decibels - SILENCE_DECIBELS) / (PEAK_DECIBELS - SILENCE_DECIBELS);
  return Math.min(1, Math.max(0, level)) || 0;
}

/**
 * Reports the level of at most one audio sample per interval and skips the rest, since players
 * send a buffer far more often than a meter needs to move.
 */
export function throttleAudioLevels(
  listener: (level: number) => void,
  now: () => number = Date.now,
) {
  let last = -Infinity;
  return (sample: { readonly channels: AudioChannels }) => {
    const time = now();
    if (time - last < 1000 / LEVELS_PER_SECOND) return;
    last = time;
    listener(audioSampleLevel(sample.channels));
  };
}
