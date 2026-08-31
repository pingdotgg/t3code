export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -60;
const VOICE_NOISE_FLOOR_AMPLITUDE = 10 ** (VOICE_NOISE_FLOOR_DECIBELS / 20);

/** Converts measured decibels to compressed amplitude, reserving full height for 0 dB. */
export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= VOICE_NOISE_FLOOR_DECIBELS) return 0;
  if (decibels >= 0) return 1;

  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - VOICE_NOISE_FLOOR_AMPLITUDE) / (1 - VOICE_NOISE_FLOOR_AMPLITUDE));
}
