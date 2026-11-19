import type { NotificationJingleId } from "@t3tools/contracts";

/**
 * Original notification jingles, synthesized with Web Audio so they cost no download and no
 * file in the bundle. Each is a short phrase of notes with its own timbre and envelope.
 */
interface JingleNote {
  /** Hz. */
  readonly frequency: number;
  /** Seconds from the jingle's start. */
  readonly at: number;
  readonly duration: number;
  readonly gain?: number;
  /** Slide to this frequency over the note. */
  readonly glideTo?: number;
}

interface JingleVoice {
  readonly wave: OscillatorType;
  /** Extra oscillators as frequency ratios, for bell and piano partials. */
  readonly partials?: ReadonlyArray<{ readonly ratio: number; readonly gain: number }>;
  readonly attack: number;
  readonly release: number;
  readonly lowpass?: number;
  /** A quiet repeat after this many seconds, for space. */
  readonly echo?: { readonly delay: number; readonly gain: number };
}

export interface JingleSpec {
  readonly id: NotificationJingleId;
  readonly label: string;
  readonly description: string;
  readonly voice: JingleVoice;
  readonly notes: ReadonlyArray<JingleNote>;
}

const note = (name: string): number => {
  const match = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!match) throw new Error(`Bad note ${name}`);
  const semitones: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  const octave = Number(match[3]);
  const offset = (semitones[match[1]!] ?? 0) + accidental + (octave - 4) * 12;
  return 440 * 2 ** (offset / 12);
};

const BELL = [
  { ratio: 2.76, gain: 0.35 },
  { ratio: 5.4, gain: 0.12 },
];
const PIANO = [
  { ratio: 2, gain: 0.3 },
  { ratio: 3, gain: 0.12 },
  { ratio: 4, gain: 0.05 },
];

export const NOTIFICATION_JINGLES: ReadonlyArray<JingleSpec> = [
  {
    id: "soft-chime",
    label: "Soft Chime",
    description: "Two warm, rising tones.",
    voice: {
      wave: "sine",
      partials: BELL,
      attack: 0.005,
      release: 0.9,
      echo: { delay: 0.18, gain: 0.2 },
    },
    notes: [
      { frequency: note("E5"), at: 0, duration: 0.5, gain: 0.8 },
      { frequency: note("B5"), at: 0.14, duration: 0.8, gain: 0.7 },
    ],
  },
  {
    id: "digital-pulse",
    label: "Digital Pulse",
    description: "Three quick square-wave blips.",
    voice: { wave: "square", attack: 0.003, release: 0.06, lowpass: 2600 },
    notes: [
      { frequency: note("A5"), at: 0, duration: 0.07, gain: 0.45 },
      { frequency: note("A5"), at: 0.11, duration: 0.07, gain: 0.45 },
      { frequency: note("E6"), at: 0.22, duration: 0.12, gain: 0.5 },
    ],
  },
  {
    id: "crystal-bell",
    label: "Crystal Bell",
    description: "A bright bell with a long shimmer.",
    voice: {
      wave: "sine",
      partials: BELL,
      attack: 0.002,
      release: 1.4,
      echo: { delay: 0.24, gain: 0.25 },
    },
    notes: [
      { frequency: note("C6"), at: 0, duration: 1.1, gain: 0.7 },
      { frequency: note("G6"), at: 0.09, duration: 1, gain: 0.35 },
    ],
  },
  {
    id: "gentle-piano",
    label: "Gentle Piano",
    description: "A soft major arpeggio.",
    voice: { wave: "triangle", partials: PIANO, attack: 0.004, release: 0.7, lowpass: 3200 },
    notes: [
      { frequency: note("C5"), at: 0, duration: 0.45, gain: 0.6 },
      { frequency: note("E5"), at: 0.12, duration: 0.45, gain: 0.55 },
      { frequency: note("G5"), at: 0.24, duration: 0.45, gain: 0.55 },
      { frequency: note("C6"), at: 0.36, duration: 0.8, gain: 0.6 },
    ],
  },
  {
    id: "ambient-synth",
    label: "Ambient Synth",
    description: "A slow swelling pad.",
    voice: {
      wave: "sawtooth",
      attack: 0.25,
      release: 0.9,
      lowpass: 1100,
      echo: { delay: 0.3, gain: 0.3 },
    },
    notes: [
      { frequency: note("A3"), at: 0, duration: 1, gain: 0.3 },
      { frequency: note("E4"), at: 0, duration: 1, gain: 0.25 },
      { frequency: note("C#5"), at: 0.15, duration: 0.9, gain: 0.2 },
    ],
  },
  {
    id: "arcade",
    label: "Arcade Notification",
    description: "A chiptune coin-style flourish.",
    voice: { wave: "square", attack: 0.002, release: 0.05, lowpass: 4200 },
    notes: [
      { frequency: note("B5"), at: 0, duration: 0.07, gain: 0.4 },
      { frequency: note("E6"), at: 0.07, duration: 0.07, gain: 0.4 },
      { frequency: note("G6"), at: 0.14, duration: 0.07, gain: 0.4 },
      { frequency: note("B6"), at: 0.21, duration: 0.18, gain: 0.4 },
    ],
  },
  {
    id: "minimal-pop",
    label: "Minimal Pop",
    description: "One short, rounded pop.",
    voice: { wave: "sine", attack: 0.002, release: 0.12 },
    notes: [{ frequency: note("G5"), at: 0, duration: 0.09, gain: 0.9, glideTo: note("D5") }],
  },
  {
    id: "classic-desktop",
    label: "Classic Desktop",
    description: "A familiar two-note ding-dong.",
    voice: { wave: "sine", partials: [{ ratio: 2, gain: 0.2 }], attack: 0.004, release: 0.5 },
    notes: [
      { frequency: note("G5"), at: 0, duration: 0.3, gain: 0.7 },
      { frequency: note("D5"), at: 0.26, duration: 0.55, gain: 0.7 },
    ],
  },
  {
    id: "futuristic-signal",
    label: "Futuristic Signal",
    description: "A rising sweep with a sparkle.",
    voice: { wave: "triangle", attack: 0.01, release: 0.25, echo: { delay: 0.12, gain: 0.3 } },
    notes: [
      { frequency: note("C5"), at: 0, duration: 0.28, gain: 0.5, glideTo: note("C6") },
      { frequency: note("G6"), at: 0.3, duration: 0.22, gain: 0.35 },
    ],
  },
];

export function jingleSpec(id: NotificationJingleId): JingleSpec {
  return NOTIFICATION_JINGLES.find((jingle) => jingle.id === id) ?? NOTIFICATION_JINGLES[0]!;
}

/** Seconds until the jingle's last sound (echo included) has faded. */
function jingleDuration(spec: JingleSpec): number {
  const end = Math.max(...spec.notes.map((entry) => entry.at + entry.duration));
  return end + spec.voice.release + (spec.voice.echo?.delay ?? 0);
}

function scheduleNote(
  context: BaseAudioContext,
  destination: AudioNode,
  voice: JingleVoice,
  entry: JingleNote,
  start: number,
  level: number,
) {
  const envelope = context.createGain();
  const peak = (entry.gain ?? 0.6) * level;
  const begin = start + entry.at;
  const end = begin + entry.duration + voice.release;
  envelope.gain.setValueAtTime(0.0001, begin);
  envelope.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), begin + voice.attack);
  envelope.gain.setValueAtTime(Math.max(peak, 0.0002), begin + entry.duration);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
  envelope.connect(destination);
  const partials = [{ ratio: 1, gain: 1 }, ...(voice.partials ?? [])];
  for (const partial of partials) {
    const oscillator = context.createOscillator();
    oscillator.type = partial.ratio === 1 ? voice.wave : "sine";
    oscillator.frequency.setValueAtTime(entry.frequency * partial.ratio, begin);
    if (entry.glideTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        entry.glideTo * partial.ratio,
        begin + entry.duration,
      );
    }
    const partialGain = context.createGain();
    partialGain.gain.value = partial.gain;
    oscillator.connect(partialGain).connect(envelope);
    oscillator.start(begin);
    oscillator.stop(end + 0.02);
  }
}

/** Schedules the jingle on `context` at `volume` (0 to 1). Returns when it will have ended. */
export function playJingle(
  context: BaseAudioContext,
  id: NotificationJingleId,
  volume: number,
): number {
  const spec = jingleSpec(id);
  const start = context.currentTime + 0.01;
  const master = context.createGain();
  // Square and sawtooth voices are much louder than sine at the same gain.
  const loudness = spec.voice.wave === "square" || spec.voice.wave === "sawtooth" ? 0.18 : 0.32;
  master.gain.value = Math.max(0, Math.min(1, volume)) * loudness;
  let output: AudioNode = master;
  if (spec.voice.lowpass !== undefined) {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = spec.voice.lowpass;
    master.connect(filter);
    output = filter;
  }
  output.connect(context.destination);
  for (const entry of spec.notes) scheduleNote(context, master, spec.voice, entry, start, 1);
  if (spec.voice.echo) {
    for (const entry of spec.notes) {
      scheduleNote(
        context,
        master,
        spec.voice,
        { ...entry, at: entry.at + spec.voice.echo.delay },
        start,
        spec.voice.echo.gain,
      );
    }
  }
  return start + jingleDuration(spec);
}
