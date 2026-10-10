/**
 * The order voice input picks a microphone in. An entry is either a kind,
 * which covers every connected microphone of that kind not listed by name, or
 * a device remembered the first time dictation saw it connected. iOS lists
 * only connected inputs, and only while a recording session is set up, so a
 * device cannot be listed before then.
 */
export const MICROPHONE_KINDS = ["wired", "bluetooth", "builtIn", "carPlay"] as const;

export type MicrophoneKind = (typeof MICROPHONE_KINDS)[number];

export interface MicrophoneDevice {
  readonly kind: MicrophoneKind;
  /** iOS's port identifier, stable across reconnects of the same device. */
  readonly uid: string;
  readonly name: string;
}

export type MicrophoneEntry = { readonly kind: MicrophoneKind } | MicrophoneDevice;

interface MicrophoneInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

// Raw values of AVAudioSession.Port. A car without CarPlay connects as a
// Bluetooth headset, so it is a Bluetooth device.
const KIND_BY_PORT_TYPE: Readonly<Record<string, MicrophoneKind>> = {
  MicrophoneWired: "wired",
  USBAudio: "wired",
  LineIn: "wired",
  BluetoothHFP: "bluetooth",
  BluetoothLE: "bluetooth",
  MicrophoneBuiltIn: "builtIn",
  CarAudio: "carPlay",
};

// Built-in and CarPlay are listed only as kinds: a phone has one built-in
// microphone, and CarPlay is the car.
const DEVICE_KINDS: ReadonlySet<MicrophoneKind> = new Set(["wired", "bluetooth"]);

const rank = (kind: MicrophoneKind) => MICROPHONE_KINDS.indexOf(kind);

export function isMicrophoneKind(value: unknown): value is MicrophoneKind {
  return (MICROPHONE_KINDS as ReadonlyArray<unknown>).includes(value);
}

export function isMicrophoneDevice(entry: MicrophoneEntry): entry is MicrophoneDevice {
  return "uid" in entry;
}

export function microphoneEntryKey(entry: MicrophoneEntry): string {
  return isMicrophoneDevice(entry) ? entry.uid : `kind:${entry.kind}`;
}

/**
 * The saved order with each kind listed once. A missing kind goes after the
 * devices of that kind, else above the first kind ranked below it by default,
 * which puts CarPlay below the built-in microphone.
 */
export function microphoneOrder(
  saved: ReadonlyArray<MicrophoneEntry> = [],
): ReadonlyArray<MicrophoneEntry> {
  const order: MicrophoneEntry[] = [];
  const keys = new Set<string>();
  for (const entry of saved) {
    const row =
      isMicrophoneDevice(entry) && DEVICE_KINDS.has(entry.kind) ? entry : { kind: entry.kind };
    const key = microphoneEntryKey(row);
    if (keys.has(key)) continue;
    keys.add(key);
    order.push(row);
  }
  for (const kind of MICROPHONE_KINDS) {
    if (keys.has(`kind:${kind}`)) continue;
    const lastDevice = order.map((entry) => entry.kind).lastIndexOf(kind);
    const below = order.findIndex(
      (entry) => !isMicrophoneDevice(entry) && rank(entry.kind) > rank(kind),
    );
    order.splice(lastDevice !== -1 ? lastDevice + 1 : below !== -1 ? below : order.length, 0, {
      kind,
    });
  }
  return order;
}

/**
 * Lists connected wired and Bluetooth microphones by name and refreshes
 * renamed ones. A new device goes just above its kind, keeping the rank it had
 * while unlisted. Returns `order` itself when nothing changed.
 */
export function rememberMicrophones(
  order: ReadonlyArray<MicrophoneEntry>,
  inputs: ReadonlyArray<MicrophoneInput>,
): ReadonlyArray<MicrophoneEntry> {
  let next: MicrophoneEntry[] | null = null;
  for (const input of inputs) {
    const kind = KIND_BY_PORT_TYPE[input.type];
    if (!kind || !DEVICE_KINDS.has(kind)) continue;
    const current = next ?? order;
    const index = current.findIndex((entry) => microphoneEntryKey(entry) === input.uid);
    const existing = current[index];
    if (existing && isMicrophoneDevice(existing) && existing.name === input.name) continue;
    next ??= [...order];
    const device = { kind, uid: input.uid, name: input.name };
    if (index !== -1) {
      next[index] = device;
      continue;
    }
    const kindRow = next.findIndex((entry) => microphoneEntryKey(entry) === `kind:${kind}`);
    next.splice(kindRow === -1 ? next.length : kindRow, 0, device);
  }
  return next ?? order;
}

/** The connected input of the first entry that has one, or null to leave the route to iOS. */
export function preferredMicrophoneInput<Input extends MicrophoneInput>(
  inputs: ReadonlyArray<Input>,
  order: ReadonlyArray<MicrophoneEntry>,
): Input | null {
  const listed = new Set(order.filter(isMicrophoneDevice).map((device) => device.uid));
  for (const entry of order) {
    const input = inputs.find((candidate) =>
      isMicrophoneDevice(entry)
        ? candidate.uid === entry.uid
        : KIND_BY_PORT_TYPE[candidate.type] === entry.kind && !listed.has(candidate.uid),
    );
    if (input) return input;
  }
  return null;
}
