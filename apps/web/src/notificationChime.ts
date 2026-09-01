/**
 * The sound played with a thread-completion notification.
 *
 * Synthesized rather than bundled: desktop browsers ignore a notification's
 * own sound options, so the app has to make one, and two sine notes cost no
 * asset and no decode step.
 */

/** B5 then E6 — a short rising pair, distinct from system alert sounds. Triangle
 *  rather than sine: the added harmonics read louder at the same amplitude. */
const CHIME_NOTES: ReadonlyArray<{ frequency: number; offsetSeconds: number }> = [
  { frequency: 987.77, offsetSeconds: 0 },
  { frequency: 1318.51, offsetSeconds: 0.11 },
];
const NOTE_DURATION_SECONDS = 0.16;
const MAX_CHIME_GAIN = 0.8;
/**
 * Decibels lost per point below full volume. Loudness is logarithmic, so a
 * linear amplitude ramp bunches the whole useful range at the top; 0.5 dB a
 * point spreads it evenly and leaves 100 genuinely loud.
 */
const DECIBELS_PER_VOLUME_POINT = 0.5;

type AudioContextConstructor = typeof AudioContext;

let sharedContext: AudioContext | null = null;

export function chimeGainForVolume(volume: number): number {
  const belowFull = 100 - Math.min(100, Math.max(0, volume));
  return MAX_CHIME_GAIN * 10 ** ((-belowFull * DECIBELS_PER_VOLUME_POINT) / 20);
}

function ensureContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const Constructor =
    window.AudioContext ??
    (window as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!Constructor) return null;
  try {
    sharedContext = new Constructor();
  } catch {
    return null;
  }
  return sharedContext;
}

/**
 * Creates and resumes the context. Call from a user gesture, synchronously:
 * browsers start a context suspended, and notes scheduled on a suspended
 * context are dropped without an error.
 */
export function primeNotificationChime(): void {
  const context = ensureContext();
  if (context?.state !== "suspended") return;
  void context.resume().catch(() => {});
}

export function playNotificationChime(volume: number): void {
  const context = ensureContext();
  // Scheduling onto a suspended context queues notes against a clock that is
  // not advancing: they would all fire at once whenever it resumes. Drop the
  // chime instead and let the next gesture prime it.
  if (context?.state !== "running") {
    primeNotificationChime();
    return;
  }

  const startedAt = context.currentTime + 0.01;
  for (const note of CHIME_NOTES) {
    const noteStartedAt = startedAt + note.offsetSeconds;
    const noteEndedAt = noteStartedAt + NOTE_DURATION_SECONDS;

    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = note.frequency;

    // Ramped, not switched: a square-edged gain change clicks.
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, noteStartedAt);
    gain.gain.linearRampToValueAtTime(chimeGainForVolume(volume), noteStartedAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEndedAt);

    oscillator.connect(gain).connect(context.destination);
    oscillator.addEventListener("ended", () => gain.disconnect(), { once: true });
    oscillator.start(noteStartedAt);
    oscillator.stop(noteEndedAt);
  }
}
