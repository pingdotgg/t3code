/**
 * The kinds of microphone voice input can record from, in the order the user
 * prefers them. iOS reports each input's port type; several port types share
 * a kind. A car without CarPlay connects as a Bluetooth headset, so only
 * CarPlay can be ranked on its own.
 */
export const MICROPHONE_KINDS = ["wired", "bluetooth", "builtIn", "carPlay"] as const;

export type MicrophoneKind = (typeof MICROPHONE_KINDS)[number];

/** CarPlay ranks below the device microphone so dictation in the car avoids the car's microphone. */
export const DEFAULT_MICROPHONE_PRIORITY: ReadonlyArray<MicrophoneKind> = MICROPHONE_KINDS;

// Raw values of AVAudioSession.Port.
const KIND_BY_PORT_TYPE: Readonly<Record<string, MicrophoneKind>> = {
  MicrophoneBuiltIn: "builtIn",
  BluetoothHFP: "bluetooth",
  BluetoothLE: "bluetooth",
  MicrophoneWired: "wired",
  USBAudio: "wired",
  LineIn: "wired",
  CarAudio: "carPlay",
};

export function isMicrophoneKind(value: unknown): value is MicrophoneKind {
  return (MICROPHONE_KINDS as ReadonlyArray<unknown>).includes(value);
}

/** The saved order, with kinds it does not mention appended in their default order. */
export function resolveMicrophonePriority(
  saved: ReadonlyArray<MicrophoneKind> | undefined,
): ReadonlyArray<MicrophoneKind> {
  return [...new Set([...(saved ?? []), ...DEFAULT_MICROPHONE_PRIORITY])];
}

/** The available input of the highest-ranked kind, or null to leave the route to iOS. */
export function preferredMicrophoneInput<Input extends { readonly type: string }>(
  inputs: ReadonlyArray<Input>,
  priority: ReadonlyArray<MicrophoneKind>,
): Input | null {
  for (const kind of priority) {
    const input = inputs.find((candidate) => KIND_BY_PORT_TYPE[candidate.type] === kind);
    if (input) return input;
  }
  return null;
}
