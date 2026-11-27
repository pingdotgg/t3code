import type { TeamNotificationSoundPreset } from "@t3tools/contracts/settings";

export type NotificationSoundKind = "completion" | "input";

export type SynthesizedTeamNotificationSoundPreset = Exclude<
  TeamNotificationSoundPreset,
  "classic" | "off"
>;

interface HarmonicPartial {
  readonly ratio: number;
  readonly gain: number;
  readonly decaySeconds: number;
}

interface SynthToneSpec {
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly frequencyHz: number;
  readonly attackSeconds: number;
  readonly amplitude: number;
  readonly partials: ReadonlyArray<HarmonicPartial>;
  readonly vibratoHz?: number;
  readonly vibratoDepth?: number;
}

interface PresetSynthSpec {
  readonly durationSeconds: number;
  readonly peakGain: number;
  readonly tones: ReadonlyArray<SynthToneSpec>;
}

const CHIME_PARTIALS: ReadonlyArray<HarmonicPartial> = [
  { ratio: 1, gain: 1, decaySeconds: 0.2 },
  { ratio: 2, gain: 0.24, decaySeconds: 0.12 },
  { ratio: 3, gain: 0.08, decaySeconds: 0.07 },
];

const BELL_PARTIALS: ReadonlyArray<HarmonicPartial> = [
  { ratio: 1, gain: 1, decaySeconds: 0.34 },
  { ratio: 2, gain: 0.32, decaySeconds: 0.2 },
  { ratio: 2.756, gain: 0.14, decaySeconds: 0.11 },
  { ratio: 4, gain: 0.06, decaySeconds: 0.06 },
];

const MARIMBA_PARTIALS: ReadonlyArray<HarmonicPartial> = [
  { ratio: 1, gain: 1, decaySeconds: 0.095 },
  { ratio: 4, gain: 0.24, decaySeconds: 0.022 },
];

const PULSE_PARTIALS: ReadonlyArray<HarmonicPartial> = [
  { ratio: 1, gain: 1, decaySeconds: 0.24 },
  { ratio: 1.5, gain: 0.2, decaySeconds: 0.2 },
  { ratio: 2, gain: 0.12, decaySeconds: 0.16 },
];

const SYNTH_PRESET_SPECS: Readonly<
  Record<
    SynthesizedTeamNotificationSoundPreset,
    Readonly<Record<NotificationSoundKind, PresetSynthSpec>>
  >
> = {
  chime: {
    completion: {
      durationSeconds: 0.56,
      peakGain: 0.32,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.38,
          frequencyHz: 1046.5,
          attackSeconds: 0.006,
          amplitude: 0.85,
          partials: CHIME_PARTIALS,
        },
        {
          startSeconds: 0.11,
          durationSeconds: 0.44,
          frequencyHz: 1567.98,
          attackSeconds: 0.006,
          amplitude: 1,
          partials: CHIME_PARTIALS,
        },
      ],
    },
    input: {
      durationSeconds: 0.54,
      peakGain: 0.32,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.22,
          frequencyHz: 880,
          attackSeconds: 0.005,
          amplitude: 0.85,
          partials: CHIME_PARTIALS,
        },
        {
          startSeconds: 0.1,
          durationSeconds: 0.24,
          frequencyHz: 1174.66,
          attackSeconds: 0.005,
          amplitude: 0.92,
          partials: CHIME_PARTIALS,
        },
        {
          startSeconds: 0.2,
          durationSeconds: 0.32,
          frequencyHz: 1318.51,
          attackSeconds: 0.005,
          amplitude: 1,
          partials: CHIME_PARTIALS,
        },
      ],
    },
  },
  bell: {
    completion: {
      durationSeconds: 0.7,
      peakGain: 0.32,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.68,
          frequencyHz: 698.46,
          attackSeconds: 0.004,
          amplitude: 1,
          partials: BELL_PARTIALS,
        },
        {
          startSeconds: 0.075,
          durationSeconds: 0.55,
          frequencyHz: 1396.91,
          attackSeconds: 0.006,
          amplitude: 0.38,
          partials: BELL_PARTIALS,
        },
      ],
    },
    input: {
      durationSeconds: 0.56,
      peakGain: 0.32,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.28,
          frequencyHz: 783.99,
          attackSeconds: 0.004,
          amplitude: 0.9,
          partials: BELL_PARTIALS,
        },
        {
          startSeconds: 0.16,
          durationSeconds: 0.38,
          frequencyHz: 1046.5,
          attackSeconds: 0.004,
          amplitude: 1,
          partials: BELL_PARTIALS,
        },
      ],
    },
  },
  marimba: {
    completion: {
      durationSeconds: 0.42,
      peakGain: 0.36,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.24,
          frequencyHz: 587.33,
          attackSeconds: 0.002,
          amplitude: 0.92,
          partials: MARIMBA_PARTIALS,
        },
        {
          startSeconds: 0.095,
          durationSeconds: 0.3,
          frequencyHz: 880,
          attackSeconds: 0.002,
          amplitude: 1,
          partials: MARIMBA_PARTIALS,
        },
      ],
    },
    input: {
      durationSeconds: 0.46,
      peakGain: 0.36,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.18,
          frequencyHz: 659.25,
          attackSeconds: 0.002,
          amplitude: 0.9,
          partials: MARIMBA_PARTIALS,
        },
        {
          startSeconds: 0.085,
          durationSeconds: 0.18,
          frequencyHz: 783.99,
          attackSeconds: 0.002,
          amplitude: 1,
          partials: MARIMBA_PARTIALS,
        },
        {
          startSeconds: 0.17,
          durationSeconds: 0.26,
          frequencyHz: 659.25,
          attackSeconds: 0.002,
          amplitude: 0.85,
          partials: MARIMBA_PARTIALS,
        },
      ],
    },
  },
  pulse: {
    completion: {
      durationSeconds: 0.58,
      peakGain: 0.3,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.52,
          frequencyHz: 523.25,
          attackSeconds: 0.028,
          amplitude: 0.72,
          partials: PULSE_PARTIALS,
          vibratoHz: 5.5,
          vibratoDepth: 0.05,
        },
        {
          startSeconds: 0.035,
          durationSeconds: 0.52,
          frequencyHz: 659.25,
          attackSeconds: 0.03,
          amplitude: 0.65,
          partials: PULSE_PARTIALS,
          vibratoHz: 5.5,
          vibratoDepth: 0.05,
        },
        {
          startSeconds: 0.07,
          durationSeconds: 0.5,
          frequencyHz: 783.99,
          attackSeconds: 0.032,
          amplitude: 0.62,
          partials: PULSE_PARTIALS,
          vibratoHz: 5.5,
          vibratoDepth: 0.05,
        },
      ],
    },
    input: {
      durationSeconds: 0.54,
      peakGain: 0.3,
      tones: [
        {
          startSeconds: 0,
          durationSeconds: 0.22,
          frequencyHz: 587.33,
          attackSeconds: 0.02,
          amplitude: 0.85,
          partials: PULSE_PARTIALS,
        },
        {
          startSeconds: 0.18,
          durationSeconds: 0.34,
          frequencyHz: 880,
          attackSeconds: 0.022,
          amplitude: 1,
          partials: PULSE_PARTIALS,
        },
      ],
    },
  },
};

const bufferCacheByContext = new WeakMap<AudioContext, Map<string, AudioBuffer>>();

let activePreviewSource: AudioBufferSourceNode | null = null;

export function isSynthesizedTeamNotificationSoundPreset(
  preset: TeamNotificationSoundPreset,
): preset is SynthesizedTeamNotificationSoundPreset {
  return preset !== "classic" && preset !== "off";
}

function teamNotificationSoundSlotKey(
  preset: SynthesizedTeamNotificationSoundPreset,
  kind: NotificationSoundKind,
): string {
  return `team:${preset}:${kind}`;
}

function synthesizeNotificationBuffer(context: AudioContext, spec: PresetSynthSpec): AudioBuffer {
  const sampleRate = context.sampleRate > 0 ? context.sampleRate : 44100;
  const frameCount = Math.max(1, Math.ceil(spec.durationSeconds * sampleRate));
  const buffer = context.createBuffer(1, frameCount, sampleRate);
  const samples = buffer.getChannelData(0);
  const tailFadeSeconds = 0.015;
  const twoPi = Math.PI * 2;

  for (const tone of spec.tones) {
    const startFrame = Math.max(0, Math.ceil(tone.startSeconds * sampleRate));
    const endFrame = Math.min(
      frameCount,
      Math.ceil((tone.startSeconds + tone.durationSeconds) * sampleRate),
    );
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const elapsed = Math.max(0, frame / sampleRate - tone.startSeconds);
      const remaining = tone.durationSeconds - elapsed;
      const attack =
        tone.attackSeconds > 0 && elapsed < tone.attackSeconds
          ? 0.5 - 0.5 * Math.cos((Math.PI * elapsed) / tone.attackSeconds)
          : 1;
      const release = remaining < tailFadeSeconds ? Math.max(0, remaining / tailFadeSeconds) : 1;
      const modulation =
        tone.vibratoHz && tone.vibratoDepth
          ? 1 - tone.vibratoDepth * (0.5 - 0.5 * Math.cos(twoPi * tone.vibratoHz * elapsed))
          : 1;

      let value = 0;
      for (const partial of tone.partials) {
        const decay = Math.exp(-elapsed / partial.decaySeconds);
        value +=
          partial.gain * decay * Math.sin(twoPi * tone.frequencyHz * partial.ratio * elapsed);
      }

      samples[frame] =
        (samples[frame] ?? 0) + value * tone.amplitude * attack * release * modulation;
    }
  }

  let maxAbs = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const abs = Math.abs(samples[frame] ?? 0);
    if (abs > maxAbs) maxAbs = abs;
  }

  if (maxAbs > 0) {
    const scale = spec.peakGain / maxAbs;
    for (let frame = 0; frame < frameCount; frame += 1) {
      samples[frame] = (samples[frame] ?? 0) * scale;
    }
  }

  return buffer;
}

/** Synthesizes and caches a Web Audio notification buffer per `(AudioContext, preset, kind)`. */
export function getSynthesizedTeamNotificationBuffer(
  context: AudioContext,
  preset: SynthesizedTeamNotificationSoundPreset,
  kind: NotificationSoundKind,
): AudioBuffer {
  let contextCache = bufferCacheByContext.get(context);
  if (!contextCache) {
    contextCache = new Map();
    bufferCacheByContext.set(context, contextCache);
  }
  const cacheKey = `${preset}:${kind}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;
  const synthesized = synthesizeNotificationBuffer(context, SYNTH_PRESET_SPECS[preset][kind]);
  contextCache.set(cacheKey, synthesized);
  return synthesized;
}

export function playSynthesizedTeamNotificationSound(input: {
  readonly context: AudioContext;
  readonly preset: SynthesizedTeamNotificationSoundPreset;
  readonly kind: NotificationSoundKind;
  readonly shouldPlay: () => boolean;
  readonly playingUntil: Map<string, number>;
}): boolean {
  const { context, preset, kind, shouldPlay, playingUntil } = input;
  if (context.state !== "running" || !shouldPlay()) return false;
  const slotKey = teamNotificationSoundSlotKey(preset, kind);
  if (context.currentTime < (playingUntil.get(slotKey) ?? 0)) return false;
  const buffer = getSynthesizedTeamNotificationBuffer(context, preset, kind);
  if (!shouldPlay() || context.state !== "running") return false;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  playingUntil.set(slotKey, context.currentTime + buffer.duration);
  return true;
}

/** Plays a preview buffer immediately, stopping any in-flight preview to prevent overlapping clipping. */
export function playPreviewAudioBuffer(context: AudioContext, buffer: AudioBuffer): void {
  if (context.state !== "running") return;
  if (activePreviewSource) {
    try {
      activePreviewSource.stop?.();
    } catch {
      // Source may have already finished.
    }
    activePreviewSource = null;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.onended = () => {
    if (activePreviewSource === source) {
      activePreviewSource = null;
    }
  };
  source.start();
  activePreviewSource = source;
}
