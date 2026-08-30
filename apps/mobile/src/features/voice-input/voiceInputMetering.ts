export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -55;
const VOICE_LOUD_DECIBELS = -20;

/** Expands average microphone power into visible speech movement while keeping quiet levels near zero. */
export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;

  const level = Math.min(
    1,
    Math.max(
      0,
      (decibels - VOICE_NOISE_FLOOR_DECIBELS) / (VOICE_LOUD_DECIBELS - VOICE_NOISE_FLOOR_DECIBELS),
    ),
  );
  return level * level * (3 - 2 * level);
}
