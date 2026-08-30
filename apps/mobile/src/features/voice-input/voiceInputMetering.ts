export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -60;

/** Maps microphone power above the noise floor to a waveform level between zero and one. */
export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;

  return Math.min(
    1,
    Math.max(0, (decibels - VOICE_NOISE_FLOOR_DECIBELS) / -VOICE_NOISE_FLOOR_DECIBELS),
  );
}
