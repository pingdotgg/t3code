/**
 * Microphones voice input has recorded near, in the order the user prefers
 * them. iOS lists only connected inputs, and only while a recording session
 * is set up, so each microphone is remembered the first time dictation sees
 * it and then appears in Settings.
 */
export const MICROPHONE_KINDS = ["wired", "bluetooth", "builtIn", "carPlay"] as const;

export type MicrophoneKind = (typeof MICROPHONE_KINDS)[number];

export interface RememberedMicrophone {
  /** iOS's port identifier, stable across reconnects of the same device. */
  readonly uid: string;
  readonly name: string;
  readonly kind: MicrophoneKind;
}

interface MicrophoneInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

// Raw values of AVAudioSession.Port. A car without CarPlay connects as a
// Bluetooth headset, so it shares the Bluetooth kind.
const KIND_BY_PORT_TYPE: Readonly<Record<string, MicrophoneKind>> = {
  MicrophoneWired: "wired",
  USBAudio: "wired",
  LineIn: "wired",
  BluetoothHFP: "bluetooth",
  BluetoothLE: "bluetooth",
  MicrophoneBuiltIn: "builtIn",
  CarAudio: "carPlay",
};

export function isMicrophoneKind(value: unknown): value is MicrophoneKind {
  return (MICROPHONE_KINDS as ReadonlyArray<unknown>).includes(value);
}

/**
 * Adds connected microphones the list has not seen and refreshes renamed ones.
 * A new microphone goes after the last one of its kind, so a preference shown
 * for AirPods carries over to a Bluetooth car. A kind seen for the first time
 * ranks by MICROPHONE_KINDS, which keeps CarPlay below the device microphone.
 * Returns `remembered` itself when nothing changed.
 */
export function rememberMicrophones(
  remembered: ReadonlyArray<RememberedMicrophone>,
  inputs: ReadonlyArray<MicrophoneInput>,
): ReadonlyArray<RememberedMicrophone> {
  const rank = (kind: MicrophoneKind) => MICROPHONE_KINDS.indexOf(kind);
  // Copies, not ES2023 array methods: Hermes does not ship toSorted or toSpliced.
  const next = [...remembered];
  let changed = false;
  const seen = inputs
    .flatMap((input) => {
      const kind = KIND_BY_PORT_TYPE[input.type];
      return kind ? [{ uid: input.uid, name: input.name, kind }] : [];
    })
    .sort((left, right) => rank(left.kind) - rank(right.kind));
  for (const microphone of seen) {
    const index = next.findIndex((entry) => entry.uid === microphone.uid);
    if (index !== -1) {
      if (next[index]!.name !== microphone.name) {
        next[index] = microphone;
        changed = true;
      }
      continue;
    }
    let at = next.length;
    for (let candidate = next.length - 1; candidate >= 0; candidate -= 1) {
      if (rank(next[candidate]!.kind) <= rank(microphone.kind)) break;
      at = candidate;
    }
    const lastOfKind = next.map((entry) => entry.kind).lastIndexOf(microphone.kind);
    next.splice(lastOfKind !== -1 ? lastOfKind + 1 : at, 0, microphone);
    changed = true;
  }
  return changed ? next : remembered;
}

/** The connected input listed first, or null to leave the route to iOS. */
export function preferredMicrophoneInput<Input extends { readonly uid: string }>(
  inputs: ReadonlyArray<Input>,
  remembered: ReadonlyArray<RememberedMicrophone>,
): Input | null {
  for (const microphone of remembered) {
    const input = inputs.find((candidate) => candidate.uid === microphone.uid);
    if (input) return input;
  }
  return null;
}
